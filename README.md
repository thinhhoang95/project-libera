# Libera

A liberal notetaking app built with Next.js, TypeScript, Tailwind CSS, filesystem storage, password authentication, and KaTeX-backed Markdown math rendering.

## Getting Started

Copy the example environment file and choose local settings:

```bash
cp .env.example .env.local
```

For development, the app accepts `LIBERA_DEV_PASSWORD` when `LIBERA_PASSWORD_HASH` is not set. The default development password is `libera`.

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

The app uses the Next.js App Router in `src/app`.

## Storage

Libera stores files under `LIBERA_DATA_DIR`, with `./data/libera` as the local fallback. The single-admin master directory is:

```text
${LIBERA_DATA_DIR}/users/admin
```

Direct child folders are notebooks. Files inside notebooks currently support:

- Markdown: `.md`, `.markdown`
- Images: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`
- PDFs: `.pdf`

The API rejects unsafe paths that escape the admin master directory.

## Math Rendering

Markdown rendering is wired through:

- `react-markdown`
- `remark-math`
- `rehype-katex`
- `katex`

Use `$...$` for inline math and `$$...$$` for block math.

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run electron:dev
npm run electron:start
npm run electron:dist
```

## Electron App

Run the desktop app in development with:

```bash
npm run electron:dev
```

Electron development starts Next.js with webpack because Turbopack's persistent
dev cache can fail on external macOS volumes that create `._*` sidecar files.

Run it against a production Next.js build with:

```bash
npm run electron:start
```

On first launch, Electron requires a fixed `LIBERA_DATA_DIR`, an `OPENAI_API_KEY`,
and an app password. These values are stored in the Electron user-data directory
instead of `.env`, then injected into the local Next.js server at startup. The
desktop shell clears the Libera session cookie on every launch, so the password
login screen is shown each time the app starts.

## Tooling

- Next.js
- TypeScript
- Tailwind CSS
- ESLint

## Password Hashes

Production should set `LIBERA_PASSWORD_HASH` and `LIBERA_SESSION_SECRET`. Password hashes use:

```text
scrypt:<salt>:<hash>
```

You can generate one from the project with:

```bash
node -e "const { randomBytes, scryptSync } = require('crypto'); const password = process.argv[1]; const salt = randomBytes(16).toString('hex'); console.log(`scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`);" "your-password"
```
