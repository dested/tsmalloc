import {ArrayBufferBuilder} from './arrayBufferBuilder';
import {assert, assertEQ, objectSafeKeys} from './utils';
import {Narrow, unreachable} from './typeUtils';

const WORD_SIZE_BYTES = 4;
const OBJECT_HEADER_ELEM_SIZE = 4;

/**
 * Memory blocks alignment by 4 for 32-bits word.
 *
 * malloc(4) -> 4
 * malloc(2) -> 4
 * malloc(5) -> 8
 * etc.
 */
function align(x: number) {
  return (((x - 1) >> 2) << 2) + WORD_SIZE_BYTES;
}

export class TSMalloc {
  constructor(public memory: ArrayBufferBuilder) {
    this.freeList = [0];
    memory.view.setUint32(0, memory.uint.byteLength);
  }

  freeList: number[];

  malloc<T>(schema: SchemaTypeObject<T>, values?: {[key in keyof T]?: SchemaValue<T[key]>}) {
    let memoryView = this.memory.view;
    const layout = schema.layout;
    const schemaSize = layout.size + OBJECT_HEADER_ELEM_SIZE;

    for (let i = 0; i < this.freeList.length; i++) {
      const sizePointer = this.freeList[i];

      const size = memoryView.getUint32(sizePointer);

      // Got the block of the needed size:
      if (size >= schemaSize) {
        memoryView.setUint32(sizePointer, schemaSize);
        this.freeList.splice(i, 1);

        // Payload data pointer.
        const dataPointer = sizePointer + OBJECT_HEADER_ELEM_SIZE;

        // Next free block if still can bump the pointer:
        const nextFree = sizePointer + schemaSize;
        if (nextFree <= memoryView.byteLength - 1) {
          if (size - schemaSize > 0) {
            memoryView.setUint32(nextFree, size - schemaSize);
            this.freeList.push(nextFree);
            this.freeList.sort();
          }
        }

        let mallocPointer = new MallocObjectPointer(schema, this, dataPointer);
        if (values) {
          for (const key of objectSafeKeys(values)) {
            const v = values[key];
            mallocPointer.set(key, v as SchemaValue<T[typeof key]>);
          }
        }
        return mallocPointer;
      }
    }
    throw new Error('out of memory');
  }
  freeObject(pointer: MallocObjectPointer<any>) {
    for (const item of pointer._schema.layout.items) {
      if (item[1].type === 'objectPointer') {
        (pointer.get(item[0])! as MallocObjectPointer<any>).free();
      }
    }
    this.freeList.push(pointer.offset - OBJECT_HEADER_ELEM_SIZE);
    this.freeList.sort();
    for (let i = 0; i < this.freeList.length - 1; i++) {
      const pointer = this.freeList[i];
      const nextPointer = this.freeList[i + 1];
      const size = this.memory.view.getUint32(pointer);
      if (pointer + size === nextPointer) {
        const nextSize = this.memory.view.getUint32(nextPointer);
        this.memory.view.setUint32(pointer, size + nextSize);
        this.freeList.splice(i + 1, 1);
        i--;
      }
    }
  }
}

type SchemaValue<T> = T extends 'float32' | 'uint8' | 'uint16'
  ? number
  : T extends string
  ? string
  : T extends {}
  ? T extends {type: 'array'; layout: Layout; value: infer J}
    ? MallocArrayPointer<J>
    : T extends {type: 'object'; layout: Layout; value: infer J}
    ? MallocObjectPointer<J>
    : never
  : never;

export class MallocObjectPointer<TObject> {
  constructor(public _schema: SchemaTypeObject<TObject>, private malloc: TSMalloc, public offset: number) {}

  set<K extends keyof TObject>(c: K, value: SchemaValue<TObject[K]>) {
    let schema = this._schema.layout.items.get(c as string)!;
    switch (schema.type) {
      case 'float32':
        this.malloc.memory.view.setFloat32(schema.offset + this.offset, value as number);
        break;
      case 'uint16':
        this.malloc.memory.view.setUint16(schema.offset + this.offset, value as number);
        break;
      case 'objectPointer':
        const v = value as MallocObjectPointer<any>;
        this.malloc.memory.view.setUint32(schema.offset + this.offset, v.offset);
        break;
      case 'uint8':
        this.malloc.memory.view.setUint8(schema.offset + this.offset, value as number);
        break;
      default:
        throw unreachable(schema);
    }
  }
  get<C extends keyof TObject>(c: C): SchemaValue<TObject[C]> {
    let schema = this._schema.layout.items.get(c as string)!;
    switch (schema.type) {
      case 'float32':
        return this.malloc.memory.view.getFloat32(schema.offset + this.offset) as SchemaValue<TObject[C]>;
      case 'uint16':
        return this.malloc.memory.view.getUint16(schema.offset + this.offset) as SchemaValue<TObject[C]>;
      case 'objectPointer':
        let pointer = this.malloc.memory.view.getUint32(schema.offset + this.offset);
        return new MallocObjectPointer(schema.schema, this.malloc, pointer) as SchemaValue<TObject[C]>;
      case 'uint8':
        return this.malloc.memory.view.getUint8(schema.offset + this.offset) as SchemaValue<TObject[C]>;
      default:
        throw unreachable(schema);
    }
  }
  schema<C extends keyof TObject>(c: C): TObject[C] {
    return this._schema.value[c] as unknown as TObject[C];
  }
  schemaArray<C extends keyof TObject>(c: C): TObject[C] {
    return null!;
  }
  free() {
    this.malloc.freeObject(this);
  }
}
export class MallocArrayPointer<T> {
  setIndex(c: number, value: SchemaValue<T>) {}
  getIndex(c: number): SchemaValue<T> {
    return null!;
  }
}

type SchemaTypeObjectOrArray<T> = SchemaTypeArray<T> | SchemaTypeObject<T>;

type SchemaTypeKeyValue<T> = {
  [key in keyof T]: 'float32' | 'uint8' | 'uint16' | SchemaTypeObjectOrArray<T[key]>;
};
export type LayoutItem =
  | {offset: number; type: 'float32' | 'uint8' | 'uint16'}
  | {offset: number; type: 'objectPointer'; schema: SchemaTypeObject<any>};

export type Layout = {size: number; items: Map<string, LayoutItem>};
export type Schema = SchemaTypeKeys<any> | SchemaTypeObjectOrArray<any>;
export type SchemaTypeKeys<T> = {
  type: 'keys';
  keys: SchemaTypeKeyValue<T>;
};
export type SchemaTypeArray<T> = {
  type: 'array';
  layout: Layout;
  value: T;
};
export type SchemaTypeObject<T> = {
  type: 'object';
  layout: Layout;
  value: SchemaTypeKeyValue<T>;
};

function getKeysLayout<T>(c: SchemaTypeKeyValue<T>) {
  let layout: Layout = {
    size: 0,
    items: new Map<string, LayoutItem>(),
  };
  for (const key of objectSafeKeys(c)) {
    let cElement = c[key];
    if (typeof cElement === 'string') {
      switch (cElement) {
        case 'float32':
          layout.items.set(key as string, {offset: layout.size, type: cElement});
          layout.size += 4;
          break;
        case 'uint16':
          layout.items.set(key as string, {offset: layout.size, type: cElement});
          layout.size += 2;
        case 'uint8':
          layout.items.set(key as string, {offset: layout.size, type: cElement});
          layout.size += 1;
          break;
        default:
          throw unreachable(cElement);
      }
    } else {
      switch (cElement.type) {
        case 'object':
          layout.items.set(key as string, {offset: layout.size, type: 'objectPointer', schema: cElement});
          layout.size += 4;
          break;
        case 'array':
          throw new Error('no array yet');
          break;
        default:
          throw unreachable(cElement);
      }
    }
  }
  layout.size = align(layout.size);
  return layout;
}

function ArrayM<T>(c: Narrow<T>): SchemaTypeArray<T> {
  return null!;
  /*
  return {
    value: c as T,
    type: 'array',
    layout: getLayout(c as T),
  };
*/
}

function ObjectM<T>(c: Narrow<T extends SchemaTypeKeyValue<infer J> ? T : never>): SchemaTypeObject<T> {
  return {
    value: c as T,
    type: 'object',
    layout: getKeysLayout(c as T),
  };
}

const memory = new ArrayBufferBuilder(1024 * 1024 * 3);
const m = new TSMalloc(memory);

function testSimple() {
  const UserSchema = ObjectM({
    a: 'float32',
    b: 'uint8',
  });
  const userPointer = m.malloc(UserSchema, {a: 2312378, b: 7});
  assert(userPointer.get('a') === 2312378);
  assert(userPointer.get('b') === 7);
  userPointer.set('a', 12);
  userPointer.set('b', 122);
  assert(userPointer.get('a') === 12);
  assert(userPointer.get('b') === 122);

  const userPointer2 = m.malloc(UserSchema, {a: 2312374, b: 75});
  assert(userPointer2.get('a') === 2312374);
  assert(userPointer2.get('b') === 75);
  userPointer2.set('a', 12);
  userPointer2.set('b', 32);
  assert(userPointer2.get('a') === 12);
  assert(userPointer2.get('b') === 32);
  userPointer.free();
  assert(userPointer2.get('a') === 12);
  assert(userPointer2.get('b') === 32);
  userPointer2.set('a', 122);
  userPointer2.set('b', 221);
  assert(userPointer2.get('a') === 122);
  assert(userPointer2.get('b') === 221);

  const userPointer3 = m.malloc(UserSchema, {a: 2312, b: 5});
  const userPointer4 = m.malloc(UserSchema, {a: 2313, b: 6});
  const userPointer5 = m.malloc(UserSchema, {a: 2314, b: 7});
  userPointer3.free();
  userPointer4.free();
  const userPointer6 = m.malloc(UserSchema, {a: 2315, b: 7});
  const userPointer7 = m.malloc(UserSchema, {a: 2316, b: 7});
  userPointer7.free();
  userPointer2.free();
  userPointer6.free();
  userPointer5.free();
  assert(m.memory.view.getUint32(0) === m.memory.view.byteLength);
}
// test0();
function testObject() {
  const UserSchema = ObjectM({
    a: 'float32',
    b: 'uint8',
    d: ObjectM({
      e: 'float32',
      g: 'uint16',
      // f: 'string',
    }),
  });
  const userPointer = m.malloc(UserSchema, {a: 2312378, b: 7});
  const dPointer = m.malloc(userPointer.schema('d'), {e: 32, g: 11});
  dPointer.set('e', 12);
  userPointer.set('d', dPointer);
  assert(userPointer.get('a') === 2312378);
  assert(userPointer.get('b') === 7);
  let dPointerGet = userPointer.get('d');
  debugger;
  assert(dPointerGet.offset === dPointer.offset);
  assertEQ(dPointerGet.get('e'), 12);
  assert(dPointerGet.get('g') === 11);
  dPointerGet.set('g', 15);
  assert(dPointerGet.get('g') === 15);
  userPointer.free();
  assert(m.memory.view.getUint32(0) === m.memory.view.byteLength);
}
testSimple();
testObject();

function test2() {
  const UserSchema2 = ObjectM({
    a: 'float32',
    b: 'uint8',
    c: ArrayM(
      ObjectM({
        c: 'float32',
        // d: 'string',
      })
    ),
    d: ObjectM({
      e: 'float32',
      // f: 'string',
    }),
  });

  const userPointer = m.malloc(UserSchema2, {a: 2312378, b: 7});
  // userPointer.set('a', 12);
  // userPointer.set('b', '12');
  const dPointer = m.malloc(userPointer.schema('d'));
  dPointer.set('e', 12);
  // dPointer.set('f', '12');
  // userPointer.set('d', dPointer);
  const number = userPointer.get('a');
  const cSchema = userPointer.schema('c');
  /*
  userPointer.set('c', m.malloc(cSchema));
  const arrayPointer = userPointer.get('c');
  arrayPointer.setIndex(1, m.malloc(cc, {c: 12, d: 'abc'}));
  const arrayIndexPointer = arrayPointer.getIndex(1);
  const string = arrayIndexPointer.get('d');
  userPointer.free();
*/
}
