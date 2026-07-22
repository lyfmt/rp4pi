export type TuiTextComponent = {
  render(width: number): string[];
  invalidate(): void;
};

export function createTextComponent(text: string): TuiTextComponent {
  return {
    render() {
      return text.split("\n");
    },
    invalidate() {}
  };
}
