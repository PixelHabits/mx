import { Array as Arr, Record as Rec } from "effect";

/** mx's releases on GitHub: `releases/download/v<version>/<file>`, and `releases/latest/download/<file>`. */
export const releasesPath = "/PixelHabits/mx/releases/";

/** Whether `url` asks GitHub for a file of mx's releases. */
export const isReleaseRequest = (url: URL) =>
	url.hostname === "github.com" && url.pathname.startsWith(releasesPath);

/** GitHub answers this prefix from the newest published release. */
const latestDownload = /^latest\/download\//u;

/** The file each platform's binary is published as. */
const binaries = {
	"linux-x64": "mx-linux-x64",
	"windows-x64": "mx-windows-x64.exe",
};

const toPem = (spki: ArrayBuffer) =>
	`-----BEGIN PUBLIC KEY-----\n${new Uint8Array(spki).toBase64()}\n-----END PUBLIC KEY-----\n`;

/**
 * mx's GitHub releases, in memory, with a throwaway Ed25519 release key. `publish` publishes a release as the release
 * job does, with the manifest signed by the release key or another one. GitHub answers `releases/latest/download/` from
 * the newest published release; the real one redirects there, and mx's HTTP client follows.
 */
export class FakeReleases {
	readonly releaseKey: CryptoKeyPair;
	/** The release key's public half, as `release/public-key.pem` holds it. */
	readonly publicKey: string;
	private readonly otherKey: CryptoKeyPair;
	/** Each published file, by its path below `releasesPath`, as `download/v0.2.0/latest.json`. */
	private readonly files = new Map<string, Uint8Array>();
	private latest = "";

	private constructor(
		releaseKey: CryptoKeyPair,
		otherKey: CryptoKeyPair,
		publicKey: string
	) {
		this.releaseKey = releaseKey;
		this.otherKey = otherKey;
		this.publicKey = publicKey;
	}

	static async make() {
		const generate = async () => {
			const generated = await crypto.subtle.generateKey("Ed25519", true, [
				"sign",
				"verify",
			]);
			if (!("privateKey" in generated)) {
				throw new Error("Ed25519 generates a key pair.");
			}
			return generated;
		};
		const releaseKey = await generate();
		const otherKey = await generate();
		return new FakeReleases(
			releaseKey,
			otherKey,
			toPem(await crypto.subtle.exportKey("spki", releaseKey.publicKey))
		);
	}

	answer(url: URL) {
		const path = url.pathname
			.slice(releasesPath.length)
			.replace(latestDownload, `download/${this.latest}/`);
		const file = this.files.get(path);
		return file === undefined
			? new Response(null, { status: 404 })
			: new Response(file);
	}

	/** Publishes release `version` with `binary` for every platform, signed with the release key unless `signedBy` says other. */
	async publish(input: {
		readonly binary: Uint8Array;
		readonly manifestSha256?: string;
		readonly signedBy?: "release" | "other";
		readonly version: string;
	}) {
		const tag = `v${input.version}`;
		const platforms = Rec.fromEntries(
			Arr.map(Rec.toEntries(binaries), ([platform, name]) => {
				this.files.set(`download/${tag}/${name}`, input.binary);
				return [
					platform,
					{
						sha256:
							input.manifestSha256 ??
							new Bun.CryptoHasher("sha256").update(input.binary).digest("hex"),
						size: input.binary.length,
						url: `https://github.com${releasesPath}download/${tag}/${name}`,
					},
				] as const;
			})
		);
		const manifest = new TextEncoder().encode(
			JSON.stringify({ platforms, version: input.version })
		);
		const key = input.signedBy === "other" ? this.otherKey : this.releaseKey;
		this.files.set(`download/${tag}/latest.json`, manifest);
		this.files.set(
			`download/${tag}/latest.json.sig`,
			new Uint8Array(
				await crypto.subtle.sign("Ed25519", key.privateKey, manifest)
			)
		);
		this.latest = tag;
	}
}
