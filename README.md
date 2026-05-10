# Market Control Plane

SST v3 API for storing stocks and positions in DynamoDB.

## Commands

```sh
npm install
npm run setup
npm run dev
npm run deploy
```

## Auth

All API requests require this header:

```sh
Authorization: Bearer $API_BEARER_TOKEN
```

The token is read from `.env`.

## API

Detailed API documentation with Mermaid diagrams is available in [`doc/api.md`](doc/api.md).

- `GET /` health check
- `GET /stocks` list stocks
- `GET /stocks/{symbol}` get one stock
- `POST /stocks` upsert one stock
- `POST /stocks/batch` upsert stocks in batches of 25 DynamoDB write requests
- `GET /positions` list positions
- `GET /positions?accountId={accountId}` list positions for one account
- `GET /positions/{accountId}/{symbol}` get one position
- `POST /positions` upsert one position

## Payloads

Single stock:

```json
{
  "symbol": "AAPL",
  "name": "Apple Inc.",
  "exchange": "NASDAQ",
  "currency": "USD",
  "sector": "Technology",
  "industry": "Consumer Electronics",
  "metadata": {
    "source": "manual"
  }
}
```

Batch stocks:

```json
{
  "stocks": [
    { "symbol": "AAPL", "name": "Apple Inc." },
    { "symbol": "MSFT", "name": "Microsoft Corp." }
  ]
}
```

Position:

```json
{
  "accountId": "default",
  "symbol": "AAPL",
  "quantity": 10,
  "averageCost": 185.5,
  "currency": "USD"
}
```
