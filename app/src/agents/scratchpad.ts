// The category agents keep their working notes in. It is an ordinary category with a fixed name, shown dimmed and
// marked "for bots" in the channel bar; members can read and edit what is in it.
export const scratchpadCategory = "Bot scratchpad";
export const scratchpadChannel = "notes";

export const isScratchpadName = (name: string): boolean => name.trim().toLowerCase() === scratchpadCategory.toLowerCase();
