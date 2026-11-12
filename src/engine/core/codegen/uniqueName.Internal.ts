/**
 * One GLSL program's generated names: `_` and a counter in base 36 (`_0`, `_1a`), so every name
 * it hands out is distinct within the program. GLSL ships as strings no end-project minifier
 * shortens, so a name carries no hint. The leading `_` keeps it apart from GLSL keywords and
 * built-ins, three's chunk locals and macros and every prefixed interface name (`u_param_*`,
 * `p_fx_*`, `in_*`/`out_*`); a base-36 tail never holds the reserved `__`.
 */
export class FXGLSLNames {
  private counter = 0;

  public next(): string {
    const name = `_${this.counter.toString(36)}`;
    this.counter += 1;
    return name;
  }
}

/**
 * One JS kernel's generated names: `hint` sanitized into an identifier and `$<counter>`, so every
 * name it hands out is distinct across the kernel's phases (their bindings merge by name). The `$`
 * keeps a generated name apart from a buffer local (`s_`/`b_`). JS kernels ship as code, so the end
 * project's minifier shortens these and the hint stays for reading.
 */
export class FXJSNames {
  private counter = 0;

  public next(hint: string): string {
    const cleaned = hint.replace(/[^A-Za-z0-9_]/g, "_");
    const safe = /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
    const name = `${safe}$${this.counter.toString()}`;
    this.counter += 1;
    return name;
  }
}
