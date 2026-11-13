// Bounded retry for TRANSIENT database failures of a whole transaction. Only deadlocks and lock-wait timeouts are recognised; any other
// error is thrown at once, and even a recognised one is retried only a few times (never indefinitely), with a short growing, jittered
// pause so two transactions that just collided do not collide again. Each retry calls the function again, so it starts a completely new
// transaction: nothing from the failed attempt (a lock, a reservation, a partial write) survives it, MySQL having rolled it back.

export const TRANSIENT_RETRIES = 2; // so at most 3 attempts in all

// Prisma reports a failed transaction as P2034 (write conflict / deadlock). A deadlock inside a RAW query comes as P2010 carrying MySQL's
// own code: 1213 = deadlock, 1205 = lock wait timeout.
export function isTransientDbError(error) {
  if (!error) return false;
  if (error.code === "P2034") return true;
  const mysqlCode = String(error.meta?.code ?? "");
  if (error.code === "P2010" && (mysqlCode === "1213" || mysqlCode === "1205")) return true;
  return /Deadlock found when trying to get lock|Lock wait timeout exceeded/i.test(String(error.message ?? ""));
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const retryDelayMs = (attempt) => 15 * (attempt + 1) + Math.floor(Math.random() * 30);

export async function withTransientRetry(run, { retries = TRANSIENT_RETRIES, wait = pause } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isTransientDbError(error) || attempt >= retries) throw error;
      await wait(retryDelayMs(attempt));
    }
  }
}
