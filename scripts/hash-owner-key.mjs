import { createHash } from "node:crypto";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const key = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
if (!key) {
  console.error("Pass the owner key on stdin.");
  process.exit(1);
}
process.stdout.write(`${createHash("sha256").update(key).digest("hex")}\n`);
