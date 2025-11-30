# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Tooling and commands

This is a Node.js/Express backend using ES modules and PostgreSQL via Drizzle ORM and Neon.

### Setup
- Install dependencies:
  - `npm install`
- Environment configuration:
  - The app uses `dotenv` and reads configuration from `.env` (see variables like `PORT`, `NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `JWT_SECRET`, etc.). Ensure `.env` exists locally before running the server.

### Running the server
- Start the development server with file watching:
  - `npm run dev`
- Directly run the app without the dev script (useful in some environments):
  - `node src/index.js`

### Linting and formatting
- Lint the whole project with ESLint (configured via `eslint.config.js`):
  - `npm run lint`
- Auto-fix lint issues where possible:
  - `npm run lint:fix`
- Format the codebase with Prettier (configured via `.prettierrc`):
  - `npm run format`
- Check formatting without writing changes:
  - `npm run format:check`
- Lint a single file (example):
  - `npx eslint src/controllers/auth.controller.js`

### Database (Drizzle ORM + Neon/Postgres)
- Drizzle is configured via `drizzle.config.js` with models in `src/models/*.js` and migrations output in the `drizzle/` directory.
- Generate migration files from the current schema:
  - `npm run db:generate`
- Apply migrations to the database referenced by `DATABASE_URL`:
  - `npm run db:migrate`
- Open the Drizzle Studio UI against the configured database:
  - `npm run db:studio`

### Tests
- There is currently **no test script** defined in `package.json` and no test runner configured.
- ESLint includes a special configuration for files under `tests/**/*.js` (Jest-style globals), but that directory does not yet exist. When adding tests, define the appropriate test runner and `npm test` script and update this section.

## Project structure and architecture

The codebase is a small Express-based HTTP API structured into configuration, routing, controllers, services, models, validations, and utilities.

### Entry points and HTTP server
- `src/index.js`
  - Loads environment variables via `dotenv/config`.
  - Imports `src/server.js` to start the HTTP server.
- `src/server.js`
  - Imports the Express app from `src/app.js`.
  - Reads the port from `process.env.PORT || 3000`.
  - Calls `app.listen(PORT, ...)` to start the server.
- `src/app.js`
  - Creates and configures the Express application.
  - Global middlewares:
    - `helmet()` for security headers.
    - `cors()` for Cross-Origin Resource Sharing.
    - `cookie-parser` for cookie parsing.
    - `express.json()` and `express.urlencoded()` for body parsing.
    - `morgan('combined')` for HTTP request logging, wired to the custom Winston logger.
  - Defines basic diagnostic routes:
    - `GET /` — simple text response and a log entry.
    - `GET /health` — JSON health status (OK, timestamp, uptime).
    - `GET /api` — simple JSON message indicating the API is running.
  - Mounts feature routes:
    - `app.use('/api/auth', authRoutes);` where `authRoutes` comes from `src/routes/auth.routes.js`.

### Configuration layer (`src/config`)
- `src/config/logger.js`
  - Creates a Winston logger with:
    - JSON logging and timestamps by default.
    - File transports:
      - `log/error.log` for `error` level and above.
      - `log/combined.log` for `info` level and above.
    - In non-production (`NODE_ENV !== 'production'`), adds a colorized console transport.
  - This logger is used throughout the app (for HTTP logging via Morgan and for application logs in controllers/services).
- `src/config/database.js`
  - Uses `@neondatabase/serverless` to create a Neon HTTP client from `process.env.DATABASE_URL`.
  - Wraps the Neon client with Drizzle ORM using `drizzle(neonClient)`.
  - Exports:
    - `db` — Drizzle ORM instance used for queries.
    - `sql` — underlying Neon tagged template if raw SQL is required.

### Domain model and persistence (`src/models` + Drizzle)
- `src/models/user.model.js`
  - Defines the `users` table via `pgTable` from `drizzle-orm/pg-core`:
    - `id` — primary key `serial`.
    - `name` — non-null `varchar(255)`.
    - `email` — non-null unique `varchar(255)`.
    - `password` — non-null `varchar(255)` (hashed password).
    - `role` — non-null `varchar(50)` defaulting to `'user'`.
    - `created_at` / `updated_at` — non-null timestamps defaulting to `now()`.
  - This table shape drives the schema used by Drizzle migrations and is the basis for auth-related operations.

### Auth module: routes, controller, service, validation, and utilities

The authentication flow is split across multiple layers to keep HTTP concerns, business logic, persistence, validation, and low-level utilities separate.

#### Routing (`src/routes/auth.routes.js`)
- Creates an Express `Router` for `/api/auth` paths.
- Defined routes:
  - `POST /api/auth/sign-up` — delegates to `signup` in `auth.controller.js`.
  - `POST /api/auth/sign-in` and `POST /api/auth/sign-out` — currently placeholder handlers returning static responses.
- All other auth-related endpoints should be added here and wired to their respective controllers.

#### Controller (`src/controllers/auth.controller.js`)
- `signup` controller orchestrates the registration flow:
  - Validates `req.body` using `signupSchema` from `src/validations/auth.validation.js`.
  - On validation failure, responds with HTTP 400 and an error payload:
    - `error: 'Validation Failed'`.
    - `details` formatted via `formatValidationError` from `src/utils/format.js`.
  - On success, destructures `name`, `email`, `role`, and `password` from the validated data.
  - Calls `createUser` from `src/services/auth.service.js` to persist the new user in the database.
  - Builds a JWT payload from the created user (`id`, `email`, `role`) and signs it via `jwttoken.sign` from `src/utils/jwt.js`.
  - Sets the JWT as a secure HTTP-only cookie using `cookies.set(res, 'token', token)` from `src/utils/cookies.js`.
  - Logs a success message via the shared `logger` and responds with HTTP 201 containing a limited user object (no password).
  - Error handling:
    - Logs unexpected errors with `logger.error('Signup error', e)` and forwards them to Express error handling via `next(e)`.
    - If the error message signals a duplicate user (currently matching `'User with this email already exists'`), responds with HTTP 409 and an `Email already exists` error response.

#### Service layer (`src/services/auth.service.js`)
- `hashPassword(password)`
  - Uses `bcrypt.hash(password, 10)` to hash the plaintext password.
  - Logs and rethrows a generic error if hashing fails (keeps failure reasons internal to the service layer).
- `createUser({ name, email, password, role = 'user' })`
  - Uses the shared `db` instance and Drizzle's `eq` helper to work against the `users` table.
  - Steps:
    - Queries the `users` table by email to check for an existing user.
    - If an existing user is found, throws an error to signal a duplicate.
    - Hashes the plaintext password using `hashPassword`.
    - Inserts a new row into `users` with the hashed password and role.
    - Uses `.returning(...)` to get a subset of columns (id, name, email, role, created_at) as the application-level user representation.
    - Logs the successful creation and returns the created user object.
  - Errors are logged and rethrown for the controller to interpret and map to HTTP responses.

#### Validation (`src/validations/auth.validation.js`)
- Uses `zod` to define request payload schemas:
  - `signupSchema` — shape of the registration payload:
    - `name` — string, trimmed, 2–255 characters.
    - `email` — valid email, lowercased, trimmed, max length 255.
    - `password` — string, length 6–128 characters.
    - `role` — enum of `'user' | 'admin'`, default `'user'`.
  - `signinSchema` — intended for sign-in payloads:
    - `email` — valid email, lowercased, trimmed.
    - `password` — non-empty string.
- These schemas decouple validation from controllers and should be reused wherever the same shapes are needed.

#### Utilities (`src/utils`)
- `src/utils/jwt.js`
  - Thin wrapper around `jsonwebtoken` with shared configuration:
    - `JWT_SECRET` read from `process.env.JWT_SECRET` (falls back to a default string if unset).
    - `JWT_EXPIRES_IN` set to `1d`.
  - Exports `jwttoken` with two methods:
    - `sign(payload)` — signs a payload into a JWT, logging and throwing a generic error if signing fails.
    - `verify(token)` — verifies a JWT, logging and throwing a generic error if verification fails.
  - Centralizes JWT configuration and error logging so controllers and middleware can stay minimal.
- `src/utils/cookies.js`
  - Provides a small abstraction over Express's cookie API with consistent security defaults:
    - `getOptions()` — returns a baseline set of cookie options:
      - `httpOnly: true` — not accessible via client-side JavaScript.
      - `secure: process.env.NODE_ENV === 'production'` — HTTPS-only in production.
      - `sameSite: 'Strict'` — CSRF-resistant cookie behavior by default.
      - `maxAge: 15 * 60 * 1000` — 15 minutes in milliseconds.
    - `set(res, name, value, options?)` — sets a cookie on the response using `res.cookie` with merged defaults and overrides.
    - `clear(res, name, options?)` — clears a cookie with matching options using `res.clearCookie`.
    - `get(req, name)` — reads a cookie from `req.cookies[name]`.
  - This module is the preferred way to manage auth cookies and any other sensitive cookies so configuration stays centralized.
- `src/utils/format.js`
  - `formatValidationError(errors)` — helper for turning Zod error objects into user-facing strings:
    - If `errors.issues` is an array, joins each `issue.message` with `, `.
    - If the structure does not match expectations, falls back to stringifying the error object.
  - Used by the auth controller to standardize validation error messaging.

### Linting and formatting configuration
- `eslint.config.js`
  - Extends `@eslint/js` recommended rules and configures the project for ES modules (`sourceType: 'module'`, `ecmaVersion: 2022`).
  - Declares common Node and browser-like globals to avoid "undefined" warnings (e.g., `process`, `setTimeout`).
  - Enforces stylistic rules such as:
    - 2-space indentation.
    - Unix linebreaks.
    - Single quotes and required semicolons.
    - `prefer-const`, `no-var`, and `object-shorthand`.
  - Disables `no-undef` (useful given module imports and custom globals).
  - Provides a separate configuration for `tests/**/*.js` with Jest-style globals (`describe`, `it`, `expect`, etc.).
  - Ignores `node_modules/**`, `coverage/**`, `logs/**`, and `drizzle/**` for linting.
- `.prettierrc`
  - Defines the code formatting style enforced by Prettier (2-space indentation, single quotes, trailing commas where valid in ES5, 80-character print width, LF line endings).

### Database migration configuration
- `drizzle.config.js`
  - Sets Drizzle to read schema definitions from `./src/models/*.js`.
  - Writes generated SQL migrations to the `./drizzle` directory.
  - Uses `postgresql` as the dialect and pulls the connection URL from `process.env.DATABASE_URL`.
  - Any time a new table or column is added to the models, migrations should be regenerated and applied using the commands described earlier.
