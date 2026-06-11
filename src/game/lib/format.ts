export function resultGrade(accuracy: number, failed: boolean): string {
  if (failed) return "F";
  if (accuracy >= 0.95) return "S";
  if (accuracy >= 0.9) return "A";
  if (accuracy >= 0.8) return "B";
  if (accuracy >= 0.7) return "C";
  return "D";
}
