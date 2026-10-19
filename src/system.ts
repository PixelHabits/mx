/** The choice for the system mx runs on, where Linux stands for any system that is not macOS or Windows. */
export const onSystem = <A>(choices: {
	readonly darwin: A;
	readonly linux: A;
	readonly win32: A;
}) => {
	switch (process.platform) {
		case "darwin":
			return choices.darwin;
		case "win32":
			return choices.win32;
		default:
			return choices.linux;
	}
};
