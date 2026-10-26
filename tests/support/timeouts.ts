import { expect, onTestFinished, vi } from "vitest";

export function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

export function expectTimeoutBudget(budgetMs: number, options: { globalFetch?: boolean } = {}) {
  const signal = AbortSignal.abort(timeoutError());
  const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
  const fetchMock = vi.fn<typeof fetch>(async () => {
    throw signal.reason;
  });
  if (options.globalFetch) vi.stubGlobal("fetch", fetchMock);
  onTestFinished(() => {
    spy.mockRestore();
    vi.unstubAllGlobals();
  });
  return {
    fetch: fetchMock,
    verify() {
      expect(spy).toHaveBeenCalledExactlyOnceWith(budgetMs);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal);
    },
  };
}
