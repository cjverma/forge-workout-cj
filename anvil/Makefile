.PHONY: build test app install uninstall dry-run test-session clean

# Build as your normal user. Never under sudo: that leaves a root-owned .build
# directory which breaks every later build.
build:
	swift build -c release

test:
	swift test

app: build
	./scripts/bundle-app.sh

# Step 1 of the safe onboarding path: shows every process a real session would
# terminate and every file it would write, and changes nothing.
dry-run: build
	sudo .build/release/anvild --dry-run --domains example.com --apps com.apple.Terminal

# Step 2: a real but short session with the escape tools exempt, so a bug cannot
# take your shell away before you have seen the daemon behave.
test-session: build
	sudo .build/release/anvild --test-mode --minutes 2 --domains example.com

install: build app
	sudo ./install.sh
	@echo
	@echo "Now: cp -R dist/Anvil.app /Applications/ && open /Applications/Anvil.app"

uninstall:
	sudo ./uninstall.sh

clean:
	rm -rf .build dist
