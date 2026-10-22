// SPDX-License-Identifier: Apache-2.0

export async function runSoakTurns(count, createEngine) {
  for (let index = 0; index < count; index += 1) {
    const engine = createEngine(index);
    let turnFailure;
    try {
      await engine.initialize();
      const result = await engine.submit({ version: '1.0', type: 'submit', request_id: `turn-${index}`, content: 'respond' }, 'lab');
      if (result?.outcome !== 'completed') {
        throw new Error(`resource soak turn ${index} ended ${result?.outcome ?? 'without an outcome'}`);
      }
    } catch (error) {
      turnFailure = error;
      throw error;
    } finally {
      // Invariant: a failed teardown invalidates the resource-soak measurement.
      try {
        await engine.shutdown({ version: '1.0', type: 'shutdown', request_id: `shutdown-${index}` });
      } catch (shutdownFailure) {
        if (turnFailure) throw new AggregateError([turnFailure, shutdownFailure], `resource soak turn ${index} and shutdown failed`);
        throw shutdownFailure;
      }
    }
  }
}
