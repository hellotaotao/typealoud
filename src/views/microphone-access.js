(function () {
  // Capture results are observations, not permanent OS permission grants.
  function outcomeForError(error) {
    if (["NotAllowedError", "PermissionDeniedError"].includes(error?.name)) return "denied";
    if (error?.name === "NotFoundError") return "no-device";
    return "error";
  }

  async function report(ipc, os, outcome) {
    if (os !== "windows") return null;
    try {
      return await ipc.invoke("report-microphone-capture", outcome);
    } catch (error) {
      console.warn("Failed to report microphone capture:", error);
      return null;
    }
  }

  async function open(ipc, os, constraints) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      // Reporting must not delay recording startup or take ownership of its stream.
      void report(ipc, os, "ok");
      return stream;
    } catch (error) {
      void report(ipc, os, outcomeForError(error));
      throw error;
    }
  }

  async function probe(ipc, os) {
    let stream;
    let outcome = "ok";
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } });
    } catch (error) {
      outcome = outcomeForError(error);
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
    // Stop the permission probe before any IPC await. Nothing is encoded or uploaded.
    return await report(ipc, os, outcome);
  }

  window.TypeAloudMicrophone = { open, probe, report };
})();
