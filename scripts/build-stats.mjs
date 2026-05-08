import { writeStats } from "../harness/publishers/stats-builder.ts";
const p = await writeStats("./data");
console.log("wrote", p);
