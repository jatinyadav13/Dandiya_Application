# Dandiya Night 2026 – pass registration

Registration, UPI payment tracking and gate check-in for Regional College's Dandiya Night.

## Run

```
npm install
DATABASE_URL=postgres://user:pass@host/db ADMIN_PASSWORD=your-strong-password UPI_ID=name@bank npm start
```

The table is created and upgraded automatically on start (old registrations are kept).

## Environment variables

| Name | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `ADMIN_PASSWORD` | yes (live) | Password for `/admin.html`. The desk stays disabled on a hosted database until you change the default |
| `UPI_ID` | no | Shows the UPI QR and pay button. Without it, students are told to pay cash at the desk |
| `PAYEE_NAME` | no | Name shown in the UPI app (default: Regional College) |
| `MAX_PASSES` | no | Maximum number of **people** (a couple pass counts as 2). `0` or empty = no limit |
| `PORT` | no | Default 3000 |

## Prices (set in `server.js`, `PRICE`)

| Ticket | Price |
|---|---|
| Regional College student, 1st year | ₹200 |
| Regional College student, 2nd to 4th year | ₹300 |
| From outside, single | ₹300 |
| From outside, couple (2 people) | ₹500 |

Prices are decided by the server, never by the browser.

## Pages

- `/` registration, payment and "Find my pass"
- `/admin.html` committee desk: confirm payments, check people in at the gate, export to Excel
