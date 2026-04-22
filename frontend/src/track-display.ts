const HUE_SEGMENTS: ReadonlyArray<readonly [number, number]> = [
	[8, 42],
	[44, 58],
	[275, 305],
	[322, 348],
];

export function displayTrackColor(trackId: string): string {
	const hash = stableHash(trackId);
	const segment = HUE_SEGMENTS[hash % HUE_SEGMENTS.length];
	const span = segment[1] - segment[0];
	const hue = segment[0] + (((hash >>> 3) % (span + 1)) >>> 0);
	return `hsl(${hue}deg 72% 48%)`;
}

export function displayTrackHue(trackId: string): number {
	const color = displayTrackColor(trackId);
	return Number.parseInt(color.slice(4, color.indexOf("deg")), 10);
}

function stableHash(value: string): number {
	let hash = 0;
	for (const character of value) {
		hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
	}
	return hash;
}
