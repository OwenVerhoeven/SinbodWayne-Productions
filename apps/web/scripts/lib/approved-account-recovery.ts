import {
  launchAccounts,
  verifyCompletedBootstrap,
  type BootstrapSnapshot,
  type BootstrapUserRow,
} from "./bootstrap";

const recoverableUsernames = new Set(["KyanWayne", "guest"]);

export function requireRecoverableApprovedAccount(
  snapshot: BootstrapSnapshot,
  username: string,
): BootstrapUserRow {
  verifyCompletedBootstrap(snapshot);
  if (!recoverableUsernames.has(username)) throw new Error("That account is not recoverable here.");
  const approved = launchAccounts.find((account) => account.username === username);
  const user = snapshot.users.find((candidate) => candidate.username === username);
  if (
    approved === undefined ||
    user === undefined ||
    user.role !== approved.role ||
    user.currentCredentialId === null ||
    !user.currentCredentialIsActive
  ) {
    throw new Error("The approved account is not in a recoverable credential state.");
  }
  return user;
}
