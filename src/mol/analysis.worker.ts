import { calculateAnalysis, type AnalysisTask } from './analysisTasks';
self.onmessage = (event: MessageEvent<AnalysisTask>) => {
  try {
    const result = calculateAnalysis(event.data);
    const meshes =
      result.kind === 'surface'
        ? [result.mesh]
        : result.kind === 'density'
          ? result.entries.map((e) => e.mesh)
          : [];
    (self as unknown as Worker).postMessage(
      { result },
      meshes.flatMap(
        (m) =>
          [
            m.vertices.buffer,
            m.triangles.buffer,
            m.lines.buffer,
          ] as ArrayBuffer[],
      ),
    );
  } catch (error) {
    (self as unknown as Worker).postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
