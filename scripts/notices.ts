import { Array as Arr, Effect, Option, Order, Schema } from "effect";
import packageJson from "../package.json" with { type: "json" };

/** The file `bun run build` writes next to the binaries; every release and the Arch packages ship it. */
export const noticesFile = "dist/THIRD_PARTY_NOTICES";

/** The Bun that `packageManager` pins, which builds every release; `licenses/` holds its LICENSE.md. */
const pinnedBun = /^bun@(\d+\.\d+\.\d+)$/u;

/** A bundled file's package folder: the path up to the last `node_modules/<name>` or `node_modules/@scope/<name>`. */
const packageFolder = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//u;

const Package = Schema.Struct({
	license: Schema.String,
	name: Schema.String,
	version: Schema.String,
});
const decodePackage = Schema.decodeEffect(Schema.fromJsonString(Package));

const rule = "=".repeat(78);
const section = (title: string, body: string) =>
	`${rule}\n${title}\n${rule}\n\n${body.trimEnd()}\n`;

const byName = Order.mapInput(
	Order.String,
	({ about }: { readonly about: typeof Package.Type }) => about.name
);

const read = (file: string) => Effect.promise(() => Bun.file(file).text());

/**
 * The third-party notices of the binaries built from `inputs`, the source files the build bundled. Every binary is a
 * Bun executable, so the notices start with Bun's LICENSE.md, which says that Bun statically links JavaScriptCore and
 * WebKit under the LGPL, and how to relink Bun; then the LGPL texts it names; then the license of each npm package the
 * build bundled.
 */
export const notices = Effect.fnUntraced(function* (inputs: readonly string[]) {
	const bun = pinnedBun.exec(packageJson.packageManager)?.[1];
	if (bun === undefined) {
		return yield* Effect.die(
			`packageManager in package.json is ${packageJson.packageManager}; the notices need it to pin one Bun, as bun@1.4.3.`
		);
	}
	const folders = Arr.dedupe(
		Arr.getSomes(
			Arr.map(inputs, (input) =>
				Option.fromNullishOr(
					packageFolder.exec(input.replaceAll("\\", "/"))?.[1]
				)
			)
		)
	);
	const packages = yield* Effect.forEach(folders, (folder) =>
		Effect.all({
			about: Effect.flatMap(read(`${folder}/package.json`), decodePackage).pipe(
				Effect.orDie
			),
			license: read(`${folder}/LICENSE`),
		})
	);
	const { version } = packageJson;
	return Arr.join(
		[
			`Third-party notices for mx ${version}\n\nmx is under the MIT license in LICENSE. Each mx binary also holds the software below, under the licenses that follow.\n`,
			section(
				`Bun ${bun}`,
				`Each mx binary is a Bun executable: bun build --compile puts mx's code into a copy of the Bun runtime. Bun's LICENSE.md follows, then the LGPL texts it refers to.\n\n${yield* read(`licenses/bun-${bun}.md`)}`
			),
			section(
				"Relinking mx",
				`mx's source code is public under the MIT license at https://github.com/PixelHabits/mx, and the tag v${version} builds this release. To relink mx with a modified JavaScriptCore, build Bun with your changes as Bun's LICENSE.md above describes. Then build mx from its source with that Bun: run bun install, then bun run build linux-x64 on Linux, bun run build windows-x64 on Windows, or bun run build darwin-arm64 or darwin-x64 on macOS. A build for the platform its Bun runs on puts that Bun into the binary.`
			),
			section(
				"GNU Library General Public License, version 2",
				yield* read("licenses/LGPL-2.0.txt")
			),
			section(
				"GNU Lesser General Public License, version 2.1",
				yield* read("licenses/LGPL-2.1.txt")
			),
			...Arr.map(Arr.sort(packages, byName), ({ about, license }) =>
				section(`${about.name} ${about.version} (${about.license})`, license)
			),
		],
		"\n"
	);
});
