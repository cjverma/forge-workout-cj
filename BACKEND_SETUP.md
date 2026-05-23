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
- `OPENAI_MODEL`: optional (default `gpt-5-mini`)
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

## 4) Frontend integration

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
