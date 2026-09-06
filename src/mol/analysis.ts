import type { AnalysisTask, AnalysisResult } from './analysisTasks';
/** One worker per active operation. Terminating it also cancels CPU-bound work. */
export function runAnalysis(task: AnalysisTask) {
  const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), {
    type: 'module',
  });
  let rejectPending: (e: Error) => void = () => {};
  let settled = false;
  const promise = new Promise<AnalysisResult>((resolve, reject) => {
    rejectPending = reject;
    worker.onmessage = (
      event: MessageEvent<{ result?: AnalysisResult; error?: string }>,
    ) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error || 'Analysis failed'));
    };
    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error(event.message || 'Analysis worker failed'));
    };
    worker.onmessageerror = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error('Could not read analysis result'));
    };
    try {
      worker.postMessage(task);
    } catch (e) {
      settled = true;
      worker.terminate();
      reject(e);
    }
  });
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectPending(new DOMException('Analysis cancelled', 'AbortError'));
    },
  };
}
