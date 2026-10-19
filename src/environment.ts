export function validateEnvironment(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Bao environment")
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string" || /[\r\n\0]/.test(item)) throw new Error("Invalid Bao environment")
  }
}
