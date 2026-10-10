// Saves the whole state to the local server. Guards against data loss:
// nothing is written until the state was loaded successfully, a revision
// check stops a stale window from overwriting newer data, and a pending
// save can be flushed when the page is closed.
export function createSaver({ getState, setRev, fetchImpl = (...args) => fetch(...args), onStatus = () => {}, onConflict = () => {}, delayMs = 300 }) {
  let timer = null;
  let chain = Promise.resolve();
  let blocked = false;
  let conflicted = false;

  const saver = {
    delayMs,
    block() {
      blocked = true;
    },
    unblock() {
      blocked = false;
    },
    schedule() {
      if (blocked || conflicted) return;
      onStatus("saving");
      clearTimeout(timer);
      timer = setTimeout(() => saver.flush(), saver.delayMs);
    },
    flush() {
      if (blocked || conflicted) return;
      clearTimeout(timer);
      timer = null;
      const body = JSON.stringify(getState());
      chain = chain
        .then(() => (conflicted ? null : fetchImpl("/api/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: body.length < 60_000
        })))
        .then(async (response) => {
          if (!response) return;
          if (response.status === 409) {
            conflicted = true;
            onStatus("conflict");
            onConflict();
            return;
          }
          if (!response.ok) throw new Error(String(response.status));
          const payload = await response.json();
          if (Number.isInteger(payload.rev)) setRev(payload.rev);
          onStatus("saved");
        })
        .catch(() => onStatus("error"));
    },
    idle() {
      return new Promise((resolve) => {
        const check = () => {
          if (timer === null) chain.then(resolve);
          else setTimeout(check, 1);
        };
        check();
      });
    }
  };
  return saver;
}
