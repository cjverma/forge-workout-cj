import Darwin
import Foundation

public enum SocketError: Error, CustomStringConvertible {
    case pathTooLong
    case createFailed(Int32)
    case bindFailed(Int32)
    case listenFailed(Int32)
    case connectFailed(Int32)
    case writeFailed(Int32)

    public var description: String {
        switch self {
        case .pathTooLong: return "socket path too long for sun_path"
        case .createFailed(let e): return "socket() failed, errno \(e)"
        case .bindFailed(let e): return "bind() failed, errno \(e)"
        case .listenFailed(let e): return "listen() failed, errno \(e)"
        case .connectFailed(let e): return "connect() failed, errno \(e)"
        case .writeFailed(let e): return "write() failed, errno \(e)"
        }
    }
}

/// Fills a `sockaddr_un` for a filesystem path. Shared so client and server cannot
/// disagree about the address layout.
private func makeAddress(path: String) throws -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let bytes = Array(path.utf8)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path)
    guard bytes.count < capacity else { throw SocketError.pathTooLong }
    // sockaddr_un() zero-initialises, so this leaves the trailing NUL in place.
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        raw.copyBytes(from: bytes)
    }
    return addr
}

/// Root-owned control socket.
///
/// This replaced an earlier world-writable drop directory. Worth being precise
/// about why: a dropped request was never an unlock vector, because the protocol
/// has no cancel or shorten opcode and a request can only widen a block. The
/// exposure was denial of service, which the size cap and rate limit close. The
/// socket is here because it removes the world-writable path entirely.
public final class ControlSocketServer {
    private let path: String
    private var listenFD: Int32 = -1
    private var lastAccepted: Date?

    public init(path: String) { self.path = path }

    public func start() throws {
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.createFailed(errno) }

        var addr = try makeAddress(path: path)
        let bound = withUnsafePointer(to: &addr) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else {
            let saved = errno
            close(fd)
            throw SocketError.bindFailed(saved)
        }
        guard Darwin.listen(fd, 16) == 0 else {
            let saved = errno
            close(fd)
            throw SocketError.listenFailed(saved)
        }
        // 0622: an unprivileged process may connect and write, but cannot read.
        chmod(path, 0o622)
        _ = fcntl(fd, F_SETFL, O_NONBLOCK)
        listenFD = fd
    }

    /// Non-blocking. Returns nil when nothing is pending, when the payload exceeds
    /// the cap, or when the rate limit rejects it.
    public func poll(now: Date = Date()) -> Data? {
        guard listenFD >= 0 else { return nil }
        let client = Darwin.accept(listenFD, nil, nil)
        guard client >= 0 else { return nil }
        defer { close(client) }

        if let last = lastAccepted, now.timeIntervalSince(last) < Limits.requestMinInterval {
            Log.warn("request rejected by rate limit")
            return nil
        }

        // A peer that connects and says nothing must not stall the enforcement loop.
        var timeout = timeval(tv_sec: 0, tv_usec: 200_000)
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        var payload = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while payload.count <= Limits.maxRequestBytes {
            let count = read(client, &buffer, buffer.count)
            if count <= 0 { break }
            payload.append(contentsOf: buffer[0..<count])
        }

        guard !payload.isEmpty else { return nil }
        guard payload.count <= Limits.maxRequestBytes else {
            Log.warn("request discarded, \(payload.count) bytes exceeds cap")
            return nil
        }
        lastAccepted = now
        return payload
    }

    deinit {
        if listenFD >= 0 { close(listenFD) }
        unlink(path)
    }
}

public enum ControlSocketClient {
    public static func send(_ data: Data, to path: String) throws {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.createFailed(errno) }
        defer { close(fd) }

        var addr = try makeAddress(path: path)
        let connected = withUnsafePointer(to: &addr) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { throw SocketError.connectFailed(errno) }

        var written = 0
        try data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            while written < raw.count {
                let count = write(fd, base.advanced(by: written), raw.count - written)
                if count <= 0 { throw SocketError.writeFailed(errno) }
                written += count
            }
        }
    }
}
