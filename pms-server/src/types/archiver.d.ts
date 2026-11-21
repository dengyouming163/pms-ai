// archiver v8 类型声明（v8 为 ESM，已移除 archiver() 工厂函数，改用 class 构造）
// 官方 @types/archiver 与 v8 导出不完全匹配，此处自定义覆盖本服务用到的 API
declare module 'archiver' {
  import { Readable } from 'node:stream';

  interface AppendOptions {
    name: string;
    prefix?: string;
    date?: Date | string;
    mode?: number;
    store?: boolean;
  }

  interface CoreOptions {
    statConcurrency?: number;
    forceZip64?: boolean;
  }

  interface ZipOptions {
    comment?: string;
    forceLocalTime?: boolean;
    forceZip64?: boolean;
    store?: boolean;
    level?: number;
    zlib?: { level?: number };
  }

  class Archiver extends Readable {
    append(source: string | Buffer | NodeJS.ReadableStream, data?: AppendOptions): this;
    finalize(): Promise<void>;
  }

  export { Archiver };
  export class ZipArchive extends Archiver {
    constructor(options?: CoreOptions & ZipOptions);
  }
  export class TarArchive extends Archiver {
    constructor(options?: CoreOptions);
  }
  export class JsonArchive extends Archiver {
    constructor(options?: CoreOptions);
  }
}
