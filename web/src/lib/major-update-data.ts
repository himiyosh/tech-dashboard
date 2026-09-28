import indexJson from "../../../data/updates/_index.json";
import {
  parseMajorUpdateState,
  type MajorUpdateMonth,
} from "./major-update-ledger.ts";

const monthModules = import.meta.glob<MajorUpdateMonth>(
  "../../../data/updates/[0-9]*.json",
  { eager: true, import: "default" },
);

export const MAJOR_UPDATE_STATE = parseMajorUpdateState(
  indexJson,
  Object.values(monthModules),
);
