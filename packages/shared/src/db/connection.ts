import { MongoClient, type Db } from "mongodb";

export interface MongoConnection {
  client: MongoClient;
  db: Db;
}

// db name comes from the URI's path (e.g. mongodb://localhost:27017/trade-bot-dev)
export async function connectMongo(uri: string): Promise<MongoConnection> {
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db() };
}

export async function closeMongo(connection: MongoConnection): Promise<void> {
  await connection.client.close();
}
