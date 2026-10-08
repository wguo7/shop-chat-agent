// Exit 0 when data/manual-index.json differs from the committed version only
// in its createdAt timestamp (a prompt-only rebuild); exit 1 otherwise.
// Used by .github/workflows/rebuild-index.yml to skip noise commits.
import fs from "fs";
import { execFileSync } from "child_process";

const PATH = "data/manual-index.json";

let committed;
try {
  committed = JSON.parse(
    execFileSync("git", ["show", `HEAD:${PATH}`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  );
} catch {
  process.exit(1); // not committed yet: treat as changed
}
const current = JSON.parse(fs.readFileSync(PATH, "utf8"));
delete committed.createdAt;
delete current.createdAt;
process.exit(JSON.stringify(committed) === JSON.stringify(current) ? 0 : 1);
