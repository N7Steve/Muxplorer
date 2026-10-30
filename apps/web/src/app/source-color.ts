export function sourceColor(source: number): string {
  return `hsl(${(210 + source * 137.508) % 360} 70% 72%)`;
}
