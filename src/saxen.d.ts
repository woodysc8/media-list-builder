declare module "saxen" {
  export class Parser {
    on(event: string, handler: (...args: any[]) => void): this;
    parse(xml: string): unknown;
  }
}
