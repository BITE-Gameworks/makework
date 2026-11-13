-- Recovery copies became opt-in (ADR 0026): the ones made by default before are removed. Owners can turn one on again.
UPDATE accounts SET recovery_copy = NULL, recovery_off = 0 WHERE recovery_copy IS NOT NULL;
