//cpu_controller.js
  
  (function (g) {
  "use strict";

  const workers = [null, null];
  const pending = new Map();

  let nextId = 1;
  let nextWorker = 0;

  function getWorker(index) {
    if (!g.Worker) return null;
    if (workers[index]) return workers[index];

    let worker;

    try {
      worker = new Worker(
        new URL("js/ai_worker.js", document.baseURI)
      );
    } catch (error) {
      console.warn("Worker unavailable; using the same AI on the main thread.");
      return null;
    }

    worker.onmessage = function (event) {
      const { id, result, error } = event.data;
      const job = pending.get(id);

      if (!job) return;

      pending.delete(id);

      if (error) {
        job.reject(new Error(error));
      } else {
        job.resolve(result);
      }
    };

    worker.onerror = function (event) {
      for (const [id, job] of pending) {
        if (job.worker === worker) {
          pending.delete(id);
          job.reject(new Error(event.message || "AI worker failed."));
        }
      }

      worker.terminate();
      workers[index] = null;
    };

    workers[index] = worker;
    return worker;
  }

  async function plan(context) {
    const index = nextWorker++ % workers.length;
    const worker = getWorker(index);

    if (!worker) {
      await g.KF.wait(0);
      return g.KF_AI.choose(context);
    }

    const id = nextId++;

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, worker });

      try {
        worker.postMessage({ id, context });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  g.AIService = { plan };
})(window);
