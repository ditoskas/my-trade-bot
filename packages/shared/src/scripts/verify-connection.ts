// Manual check that the schema/connection layer actually works end to end
// against a real Mongo instance. Not part of the app runtime — run with
// `npm run verify --workspace=@trade-bot/shared` after `docker compose up -d`.
import { closeMongo, connectMongo, ensureIndexes } from "../index";

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017/trade-bot-dev";

const connection = await connectMongo(uri);
try {
  await ensureIndexes(connection.db);
  const collections = await connection.db.listCollections().toArray();
  console.log(`Connected to "${connection.db.databaseName}".`);
  console.log(
    "Collections:",
    collections.map((c) => c.name).sort(),
  );
} finally {
  await closeMongo(connection);
}
