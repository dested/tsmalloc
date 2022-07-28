// extra types
export type Cast<A1 extends any, A2 extends any> = A1 extends A2 ? A1 : A2;
export type _Narrow<A> = [] | (A extends Narrowable ? A : never) | {[K in keyof A]: _Narrow<A[K]>};
export type Narrow<A extends any> = Cast<A, _Narrow<A>>;
export type Narrowable = string | number | bigint | boolean;
export function unreachable(t: never) {
  debugger;
  return 'UNREACHABLE ' + JSON.stringify(t);
}
