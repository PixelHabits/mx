/** A `.pem` file imported `with { type: "text" }`: Bun's text loader gives its contents as a string. */
declare module "*.pem" {
	const contents: string;
	export default contents;
}
