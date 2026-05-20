/**
 * Default dependencies using real Node.js APIs.
 */

import type { ExecFileSyncOptionsWithStringEncoding } from "child_process";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import type { Dependencies } from "./types.js";

export function createDefaultDependencies(): Dependencies {
	return {
		fetch: globalThis.fetch,
		readFile: (path: string) => {
			try {
				return fs.readFileSync(path, "utf-8");
			} catch {
				return undefined;
			}
		},
		fileExists: (path: string) => {
			try {
				return fs.existsSync(path);
			} catch {
				return false;
			}
		},
		execFileSync: (file: string, args: string[], options?: ExecFileSyncOptionsWithStringEncoding) => {
			return execFileSync(file, args, options) as string;
		},
		homedir: () => os.homedir(),
		env: process.env,
	};
}
