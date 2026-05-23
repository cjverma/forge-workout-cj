# FORGE Backend Setup (OpenAI)

## 1) Install

```bash
npm install
```

## 2) Configure

```bash
cp .env.example .env
```

Edit `.env`:
- `OPENAI_API_KEY`: your real OpenAI API key
- `OPENAI_MODEL`: optional (default `gpt-5.5`)
- `FORGE_API_TOKEN`: any long random secret you choose
- `PORT`: optional (default 8787)

Generate a token locally:

```bash
openssl rand -hex 32
```

## 3) Run

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:8787/api/health
```

## 4) Local dev auth

`config.local.js` is gitignored and tells the frontend to use `http://localhost:8787` instead of the Vercel backend. It does **not** store the token — enter your `FORGE_API_TOKEN` via the app's lock screen when you first open it locally. The token is saved to `localStorage` and sent as a Bearer header on every request.

## 5) Frontend integration

Use backend endpoints instead of direct model-provider calls:

- `POST /api/coach` with JSON body:

```json
{
  "prompt": "user text",
  "context": {"day": "Monday", "program": "Legs + Shoulders"}
}
```

- `POST /api/weekly-plan` with JSON body:

```json
{
  "weekSummary": {},
  "profile": {},
  "rules": {}
}
```

Both endpoints require header:

```http
Authorization: Bearer <FORGE_API_TOKEN>
```
