export function objectSafeKeys<T>(obj: T): (keyof T)[] {
  return Object.keys(obj) as (keyof T)[];
}

export function assert(assertion: boolean): asserts assertion {
  if (!assertion) {
    debugger;

    throw new Error('bad');
  }
}
export function assertEQ<T>(left: T, right: T): true {
  if (left !== right) {
    debugger;

    throw new Error(`bad ${left} ${right}`);
  }
  return true;
}

export function assertType<T>(assertion: any): asserts assertion is T {}

export function safeKeysExclude<T, TExclude extends keyof T>(obj: T, exclude: TExclude): Exclude<keyof T, TExclude>[] {
  return Object.keys(obj).filter((key) => key !== exclude) as Exclude<keyof T, TExclude>[];
}

export function switchType<TType extends string | number, TResult>(
  n: TType,
  options: {[key in TType]: TResult}
): TResult {
  if (options[n] === undefined) {
    throw new Error(`'Type not found', ${n}, ${JSON.stringify(options)}`);
  }
  return options[n];
}
