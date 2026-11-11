const requests = new Map<string, string>();
const listeners = new Set<() => void>();
export const revealSnapshot = (threadId: string) => requests.get(threadId);
export const subscribeReveal = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function revealElement(threadId: string, id: string) {
  requests.set(threadId, id);
  listeners.forEach((listener) => listener());
}
export function acknowledgeReveal(threadId: string, id: string) {
  if (requests.get(threadId) === id) requests.delete(threadId);
}
