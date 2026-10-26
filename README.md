# Dineout CLI + MCP

[MCP setup and client configuration](MCP.md)

Command-line and Model Context Protocol access to Dineout restaurant discovery, availability, account details, and confirmed booking workflows.

## Install

Requirements: Bun for building, and Node.js plus Chrome/Chromium for browser-assisted login and temporary booking holds.

```sh
bun install --frozen-lockfile
bun run check
bun run build
```

Add the `dineout` binary to your PATH. Keep the checkout, installed dependencies, and `dist/login-helper.mjs` available for browser workflows.

## Login

```sh
export DINEOUT_CHROME="/path/to/chromium"
dineout login start --phone "$DINEOUT_PHONE"
dineout login verify --stdin
dineout doctor
dineout login close
```

Login launches headless Chrome/Chromium in the background on the machine running the CLI; no desktop is needed by default. Supply an international phone number with its country code. Enter the latest six-digit SMS code through stdin (type the code, Enter, then Ctrl+D on Unix). Keep the same browser open between `start` and `verify`.

If reCAPTCHA requires interaction, use `login start --headed` on a machine with a display and complete the challenge normally. There are no automatic SMS retries or CAPTCHA bypasses.

```sh
dineout me
dineout login refresh
dineout logout
```

Session credentials are stored privately under `~/.config/dineout/session.json` (directory 0700, file 0600). Account reads, booking-list reads, and token refresh do not require a running browser. `logout` removes the local CLI session; it does not revoke all server sessions or clear browser-profile cookies.

## Read commands

```sh
dineout restaurants --query fish
dineout restaurants --category brunch
dineout restaurant RESTAURANT_ID_OR_SLUG
dineout filters
dineout availability RESTAURANT_ID YYYY-MM-DDTHH:mm 2
dineout waiting-times RESTAURANT_ID YYYY-MM-DDTHH:mm 2
dineout steps RESTAURANT_ID YYYY-MM-DDTHH:mm
dineout plan RESTAURANT_ID YYYY-MM-DDTHH:mm 2
dineout bookings
dineout booking BOOKING_GUID
dineout checkout BOOKING_GUID
dineout cancellation-allowed BOOKING_GUID
```

All results are JSON; `--json` is accepted. Date/time is Iceland local time in `YYYY-MM-DDTHH:mm` format. `bookings` returns the upcoming/past lists visible to the saved session. Booking GUIDs are private identifiers: use only your own authorized booking links or results.

`plan` combines restaurant metadata, available times, and booking-process requirements. `checkout` reads an existing hold’s details, policies, and payment requirements. Neither creates or completes a reservation. Reading waiting-list times does not join a waiting list. Use `steps --event-id ID --waiting-list` or `checkout GUID --waiting-list` where applicable.

## Booking writes

All writes **default to dry-run**. CLI execution requires `--yes`; `--dry-run` is explicit documentation of the default. Do not combine them. Writes are never automatically retried, including after uncertain network failures.

### 1. Create a temporary hold

Inspect availability, menus, and requirements first. Save the approved request in a private JSON file:

```json
{
  "restaurantId": 1,
  "dateTime": "2099-01-01T19:00",
  "guests": 2,
  "menus": [],
  "waitingList": false
}
```

The restaurant ID and future date above are placeholders, not availability claims. Optional `eventId` selects an event; menu selections are objects with `menuId` and `count`.

```sh
dineout reserve --file /path/to/hold.json --dry-run
dineout reserve --file /path/to/hold.json --yes
```

Execution uses the normal browser/reCAPTCHA reservation flow. The browser must already be logged in as the same customer as the saved CLI session; otherwise the request is blocked. **This creates a temporary hold, not a completed booking**, and may temporarily reduce availability. The response includes the hold result and GUID. Do not create holds merely to test the command.

### 2. Review and complete

Read the checkout information and policies for the returned GUID. Prepare a private completion file containing:

- `guid`, `bookingName`, `bookingPhone`, `bookingEmail`
- `acceptTerms: true`, only after reviewing the actual terms
- Optional `phoneNumberRegion` (default `IS`), `bookingSpecialRequest`, `bookingDietaryRestrictions`, `hasAllergies`, `isWaitingList`, and `verificationCode`
- Optional `allowSMSMarketing` and `allowRestaurantEmails` (both default to `false`)

```sh
dineout checkout BOOKING_GUID
dineout complete --file /path/to/completion.json --dry-run
dineout complete --file /path/to/completion.json --yes
```

Completion checks payment requirements first. **Bookings requiring prepayment or a card/no-show guarantee, or with unknown payment requirements, must be completed on the website.** Raw card fields are not supported. An email verification code may be required before completion succeeds; inspect the API response and obtain the code from the user rather than automatically retrying.

### Cancel or resend a booking email code

```sh
dineout cancel BOOKING_GUID --dry-run
dineout cancel BOOKING_GUID --yes
dineout resend-verification BOOKING_GUID --dry-run
dineout resend-verification BOOKING_GUID --yes
```

Cancellation executes only if the eligibility endpoint explicitly allows it. Resending verification sends another booking-completion email code; it is not a login SMS. Agents must obtain approval for the exact booking action, restaurant/time/party size, customer details, and applicable policies before executing writes.

## MCP server

Read-only is the default:

```sh
dineout mcp
```

```json
{
  "mcpServers": {
    "dineout": {
      "command": "dineout",
      "args": ["mcp"]
    }
  }
}
```

Read tools:

| Tool | Purpose |
| --- | --- |
| `dineout_doctor` | Check session refresh and customer API |
| `dineout_me` | Customer account details |
| `dineout_restaurants` | Search/filter restaurants |
| `dineout_restaurant` | Restaurant metadata by ID or slug |
| `dineout_filters` | Available filters |
| `dineout_availability` | Available booking times |
| `dineout_waiting_times` | Waiting-list times, without joining |
| `dineout_steps` | Booking-process requirements |
| `dineout_plan` | Reviewable booking plan |
| `dineout_bookings` | Upcoming and past bookings |
| `dineout_booking` | Booking confirmation details |
| `dineout_checkout` | Hold checkout and payment requirements |
| `dineout_cancellation_allowed` | Cancellation eligibility |

### MCP writes

```sh
dineout mcp --allow-writes
```

Use `"args": ["mcp", "--allow-writes"]` in client configuration to expose:

| Tool | Purpose |
| --- | --- |
| `dineout_reserve` | Browser-backed temporary hold |
| `dineout_complete` | Complete an approved no-payment booking |
| `dineout_cancel` | Cancel an eligible approved booking |
| `dineout_resend_verification` | Resend an approved booking email code |

Each tool defaults to a dry-run and requires `confirm: true` to execute. Enabling write tools alone does not submit anything. Authentication remains a CLI workflow. Client configuration is not modified automatically.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DINEOUT_CONFIG_DIR` | Private configuration directory |
| `DINEOUT_CHROME` | Chrome/Chromium executable |
| `DINEOUT_SOURCE_DIR` | Checkout path if the binary is installed elsewhere |
| `DINEOUT_NODE` | Node.js executable for the browser helper |

Common Linux Chromium paths are detected automatically. Private `browser.json` in the configuration directory can set `executablePath` and optionally `profilePath`. Login uses loopback port 9335 by default; `login --cdp http://127.0.0.1:PORT` selects an existing local browser (place `--cdp` after the login subcommand).

## Verification boundaries

Authentication, customer-account access, public discovery, and the bookings-list endpoint are verified independently of booking execution. Write methods and confirmation gates are tested with fixtures, not real reservations or cancellations. Browser-backed hold creation and subsequent completion have **not** been verified against a live booking; website changes, account permissions, challenges, and restaurant policies can affect them. No automatic payment or raw-card handling is supported.

```sh
dineout schema
bun run check
bun run build
```

## Shared MCP conventions

`dineout serve` starts the stdio server (`mcp` remains an alias).
`dineout --version` reports the CLI version. Writes remain disabled unless
`DINEOUT_MCP_ENABLE_WRITES=1` or `--allow-writes` is set at startup;
each mutation retains its existing explicit confirmation/dry-run checks.
