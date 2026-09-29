// Only paired direct messages may invoke Codex, including control commands.
export function acceptMessage(message, owner, seen) {
  if (!owner || message.userId !== owner || message.raw?.group_id) return false;
  const id = message.raw?.message_id ?? (message.raw?.client_id || undefined);
  if (id != null) {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
  }
  return true;
}
