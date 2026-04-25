import maplibregl, {
	type CustomLayerInterface,
	type CustomRenderMethodInput,
	type Map as MapGL,
} from "maplibre-gl";

export interface ElevatedTrackPoint {
	longitude: number;
	latitude: number;
	elevationMeters: number;
}

export type ElevatedTrackSegment = ElevatedTrackPoint[];

export interface ElevationRange {
	min: number;
	max: number;
}

export interface ElevatedTrackRenderInput {
	geometry: GeoJSON.Geometry;
}

export interface ElevatedTracksLayerStats {
	trackCount: number;
	segmentCount: number;
	lineVertexCount: number;
	curtainVertexCount: number;
}

export interface ElevatedTracksLayer extends CustomLayerInterface {
	getStats(): ElevatedTracksLayerStats;
	setTracks(tracks: ElevatedTrackRenderInput[]): void;
}

interface DrawRange {
	start: number;
	count: number;
}

const ELEVATED_TRACK_COLOR: [number, number, number, number] = [
	0.733,
	0.373,
	0.227,
	1,
];
const ELEVATED_CURTAIN_COLOR: [number, number, number, number] = [
	0.733,
	0.373,
	0.227,
	0.24,
];

const EMPTY_STATS: ElevatedTracksLayerStats = {
	trackCount: 0,
	segmentCount: 0,
	lineVertexCount: 0,
	curtainVertexCount: 0,
};

export function extractElevatedTrackSegments(
	geometry: GeoJSON.Geometry,
): ElevatedTrackSegment[] {
	if (geometry.type === "LineString") {
		return extractElevatedLineSegments(geometry.coordinates);
	}
	if (geometry.type === "MultiLineString") {
		return geometry.coordinates.flatMap((coordinates) =>
			extractElevatedLineSegments(coordinates),
		);
	}
	return [];
}

export function trackElevationRange(
	geometry: GeoJSON.Geometry,
): ElevationRange | null {
	const elevations = extractElevatedTrackSegments(geometry)
		.flat()
		.map((point) => point.elevationMeters);
	if (elevations.length === 0) {
		return null;
	}
	return {
		min: Math.min(...elevations),
		max: Math.max(...elevations),
	};
}

export function formatElevationRange(range: ElevationRange): string {
	return `${Math.round(range.min)}-${Math.round(range.max)} m`;
}

export function createElevatedTracksLayer(id: string): ElevatedTracksLayer {
	let map: MapGL | null = null;
	let program: WebGLProgram | null = null;
	let lineBuffer: WebGLBuffer | null = null;
	let curtainBuffer: WebGLBuffer | null = null;
	let renderContext: WebGLRenderingContext | WebGL2RenderingContext | null = null;
	let positionAttribute = -1;
	let matrixUniform: WebGLUniformLocation | null = null;
	let colorUniform: WebGLUniformLocation | null = null;
	let lineVertices = new Float32Array();
	let curtainVertices = new Float32Array();
	let drawRanges: DrawRange[] = [];
	let trackInputs: ElevatedTrackRenderInput[] = [];
	let stats: ElevatedTracksLayerStats = EMPTY_STATS;

	function rebuildBuffer(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
		const nextLineVertices: number[] = [];
		const nextCurtainVertices: number[] = [];
		const nextDrawRanges: DrawRange[] = [];
		let nextSegmentCount = 0;
		for (const track of trackInputs) {
			for (const segment of extractElevatedTrackSegments(track.geometry)) {
				nextSegmentCount += 1;
				const start = nextLineVertices.length / 3;
				let previousElevated: maplibregl.MercatorCoordinate | null = null;
				let previousGround: maplibregl.MercatorCoordinate | null = null;
				for (const point of segment) {
					const elevated = maplibregl.MercatorCoordinate.fromLngLat(
						{ lng: point.longitude, lat: point.latitude },
						point.elevationMeters,
					);
					const ground = maplibregl.MercatorCoordinate.fromLngLat(
						{ lng: point.longitude, lat: point.latitude },
						0,
					);
					nextLineVertices.push(elevated.x, elevated.y, elevated.z);
					if (previousElevated && previousGround) {
						pushVertex(nextCurtainVertices, previousGround);
						pushVertex(nextCurtainVertices, previousElevated);
						pushVertex(nextCurtainVertices, elevated);
						pushVertex(nextCurtainVertices, previousGround);
						pushVertex(nextCurtainVertices, elevated);
						pushVertex(nextCurtainVertices, ground);
					}
					previousElevated = elevated;
					previousGround = ground;
				}
				nextDrawRanges.push({ start, count: segment.length });
			}
		}

		lineVertices = new Float32Array(nextLineVertices);
		curtainVertices = new Float32Array(nextCurtainVertices);
		drawRanges = nextDrawRanges;
		stats = {
			trackCount: trackInputs.length,
			segmentCount: nextSegmentCount,
			lineVertexCount: lineVertices.length / 3,
			curtainVertexCount: curtainVertices.length / 3,
		};
		if (lineBuffer) {
			gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, lineVertices, gl.STATIC_DRAW);
		}
		if (curtainBuffer) {
			gl.bindBuffer(gl.ARRAY_BUFFER, curtainBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, curtainVertices, gl.STATIC_DRAW);
		}
		map?.triggerRepaint();
	}

	return {
		id,
		type: "custom",
		renderingMode: "3d",
		onAdd(nextMap, gl) {
			map = nextMap;
			renderContext = gl;
			const nextProgram = createProgram(gl);
			program = nextProgram;
			lineBuffer = gl.createBuffer();
			curtainBuffer = gl.createBuffer();
			positionAttribute = gl.getAttribLocation(nextProgram, "a_position");
			matrixUniform = gl.getUniformLocation(nextProgram, "u_matrix");
			colorUniform = gl.getUniformLocation(nextProgram, "u_color");
			rebuildBuffer(gl);
		},
		onRemove(_map, gl) {
			if (lineBuffer) {
				gl.deleteBuffer(lineBuffer);
			}
			if (curtainBuffer) {
				gl.deleteBuffer(curtainBuffer);
			}
			if (program) {
				gl.deleteProgram(program);
			}
			map = null;
			program = null;
			lineBuffer = null;
			curtainBuffer = null;
			renderContext = null;
			stats = EMPTY_STATS;
		},
		render(gl, options: CustomRenderMethodInput) {
			if (
				!program ||
				!lineBuffer ||
				!curtainBuffer ||
				!matrixUniform ||
				!colorUniform ||
				positionAttribute < 0
			) {
				return;
			}

			gl.useProgram(program);
			gl.enableVertexAttribArray(positionAttribute);
			gl.uniformMatrix4fv(
				matrixUniform,
				false,
				options.modelViewProjectionMatrix as Float32Array,
			);
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

			if (curtainVertices.length > 0) {
				drawBuffer(
					gl,
					curtainBuffer,
					positionAttribute,
					colorUniform,
					ELEVATED_CURTAIN_COLOR,
					gl.TRIANGLES,
					0,
					curtainVertices.length / 3,
				);
			}
			if (lineVertices.length > 0) {
				gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
				gl.vertexAttribPointer(positionAttribute, 3, gl.FLOAT, false, 0, 0);
				gl.uniform4fv(colorUniform, ELEVATED_TRACK_COLOR);
				gl.lineWidth(4);
				for (const range of drawRanges) {
					gl.drawArrays(gl.LINE_STRIP, range.start, range.count);
				}
			}
			gl.disableVertexAttribArray(positionAttribute);
		},
		getStats() {
			return stats;
		},
		setTracks(tracks) {
			trackInputs = tracks;
			if (!map || !lineBuffer || !curtainBuffer || !renderContext) {
				return;
			}
			rebuildBuffer(renderContext);
		},
	};
}

function pushVertex(
	vertices: number[],
	mercator: maplibregl.MercatorCoordinate,
): void {
	vertices.push(mercator.x, mercator.y, mercator.z);
}

function drawBuffer(
	gl: WebGLRenderingContext | WebGL2RenderingContext,
	buffer: WebGLBuffer,
	positionAttribute: number,
	colorUniform: WebGLUniformLocation,
	color: [number, number, number, number],
	mode: number,
	start: number,
	count: number,
): void {
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.vertexAttribPointer(positionAttribute, 3, gl.FLOAT, false, 0, 0);
	gl.uniform4fv(colorUniform, color);
	gl.drawArrays(mode, start, count);
}

function extractElevatedLineSegments(
	coordinates: GeoJSON.Position[],
): ElevatedTrackSegment[] {
	const segments: ElevatedTrackSegment[] = [];
	let current: ElevatedTrackSegment = [];

	for (const coordinate of coordinates) {
		const point = elevatedPointFromPosition(coordinate);
		if (!point) {
			if (current.length >= 2) {
				segments.push(current);
			}
			current = [];
			continue;
		}
		current.push(point);
	}

	if (current.length >= 2) {
		segments.push(current);
	}
	return segments;
}

function elevatedPointFromPosition(
	coordinate: GeoJSON.Position,
): ElevatedTrackPoint | null {
	const [longitude, latitude, elevationMeters] = coordinate;
	if (
		!Number.isFinite(longitude) ||
		!Number.isFinite(latitude) ||
		!Number.isFinite(elevationMeters)
	) {
		return null;
	}
	return {
		longitude,
		latitude,
		elevationMeters,
	};
}

function createProgram(
	gl: WebGLRenderingContext | WebGL2RenderingContext,
): WebGLProgram {
	const vertexShader = compileShader(
		gl,
		gl.VERTEX_SHADER,
		`
attribute vec3 a_position;
uniform mat4 u_matrix;

void main() {
  gl_Position = u_matrix * vec4(a_position, 1.0);
}
`,
	);
	const fragmentShader = compileShader(
		gl,
		gl.FRAGMENT_SHADER,
		`
precision mediump float;
uniform vec4 u_color;

void main() {
  gl_FragColor = u_color;
}
`,
	);
	const program = gl.createProgram();
	if (!program) {
		throw new Error("Could not create elevated track WebGL program");
	}
	gl.attachShader(program, vertexShader);
	gl.attachShader(program, fragmentShader);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(
			`Could not link elevated track WebGL program: ${gl.getProgramInfoLog(
				program,
			)}`,
		);
	}
	gl.deleteShader(vertexShader);
	gl.deleteShader(fragmentShader);
	return program;
}

function compileShader(
	gl: WebGLRenderingContext | WebGL2RenderingContext,
	type: number,
	source: string,
): WebGLShader {
	const shader = gl.createShader(type);
	if (!shader) {
		throw new Error("Could not create elevated track WebGL shader");
	}
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		throw new Error(
			`Could not compile elevated track WebGL shader: ${gl.getShaderInfoLog(
				shader,
			)}`,
		);
	}
	return shader;
}
