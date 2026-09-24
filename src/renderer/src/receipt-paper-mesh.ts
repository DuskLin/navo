/** A small deformable paper surface. Positions are CSS pixels; no rendering library is needed. */
export interface PaperFrame {
  width: number
  height: number
  canvasWidth: number
  canvasHeight: number
  originX: number
  originY: number
}
export interface PaperPose {
  angle: number
  pull: number
  peel: number
  lift: number
  flutter: number
  release: number
  x: number
  y: number
  side: number
  strain: number
}
const columns = 80
const rows = 64
const stride = 5
export const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value))
const smooth = (a: number, b: number, value: number) => {
  const t = clamp((value - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export class ReceiptPaperMesh {
  private gl: WebGLRenderingContext
  private program: WebGLProgram
  private buffer: WebGLBuffer
  private indices: WebGLBuffer
  private texture: WebGLTexture
  private points = new Float32Array((columns + 1) * (rows + 1) * 3)
  private vertices = new Float32Array((columns + 1) * (rows + 1) * stride)
  private indexCount: number
  private viewport: WebGLUniformLocation | null
  private alpha: WebGLUniformLocation | null
  private tear: WebGLUniformLocation | null
  private textureScale: WebGLUniformLocation | null
  private rasterWidth = 0
  private rasterHeight = 0
  private textureSize: number
  private renderSize: number
  private textureReady = false
  private pendingImage?: HTMLImageElement
  private disposed = false

  constructor(
    private canvas: HTMLCanvasElement,
    private image: HTMLImageElement,
    private invalidate: () => void
  ) {
    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      powerPreference: 'low-power'
    })
    if (!gl) throw new Error('WebGL unavailable')
    this.gl = gl
    this.textureSize = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number)
    this.renderSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number
    const shaders: WebGLShader[] = []
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error('Paper shader unavailable')
      return shader
    }
    const program = gl.createProgram()!
    gl.attachShader(
      program,
      compile(
        gl.VERTEX_SHADER,
        `
      attribute vec2 position;
      attribute vec2 uv;
      attribute float light;
      uniform vec2 viewport;
      varying highp vec2 vUv;
      varying float vLight;
      void main() {
        gl_Position = vec4(position / viewport * vec2(2., -2.) + vec2(-1., 1.), 0., 1.);
        vUv = uv;
        vLight = light;
      }
    `
      )
    )
    gl.attachShader(
      program,
      compile(
        gl.FRAGMENT_SHADER,
        `
      precision highp float;
      uniform sampler2D paper;
      uniform vec2 textureScale;
      uniform float alpha;
      uniform vec3 tear;
      varying highp vec2 vUv;
      varying float vLight;
      void main() {
        vec4 ink = texture2D(paper, vUv * textureScale);
        // Warm shadows and a cool grazing highlight make the same texture read as paper.
        vec3 color = ink.rgb * vLight;
        float edge = (1. - smoothstep(0., .0017, vUv.x)) + smoothstep(.9983, 1., vUv.x);
        color = mix(color, vec3(1., .99, .96), edge * .24);
        float across = tear.y > 0. ? vUv.x : 1. - vUv.x;
        float broken = smoothstep(1. - tear.x - .015, 1. - tear.x + .015, across) * min(1., tear.x * 8.);
        float rim = 1. - smoothstep(.2, 1.7, vUv.y * tear.z);
        float under = smoothstep(1., 1.8, vUv.y * tear.z) * (1. - smoothstep(1.8, 3.5, vUv.y * tear.z));
        color *= 1. - broken * under * .12;
        color = mix(color, vec3(1., .995, .975), rim * broken * .88);
        gl_FragColor = vec4(color, ink.a * alpha);
      }
    `
      )
    )
    gl.linkProgram(program)
    for (const shader of shaders) gl.deleteShader(shader)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error('Paper renderer unavailable')
    this.program = program
    gl.useProgram(program)
    this.buffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW)
    for (const [name, count, offset] of [
      ['position', 2, 0],
      ['uv', 2, 2],
      ['light', 1, 4]
    ] as const) {
      const location = gl.getAttribLocation(program, name)
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, count, gl.FLOAT, false, stride * 4, offset * 4)
    }
    const indices: number[] = []
    for (let row = 0; row < rows; row++)
      for (let col = 0; col < columns; col++) {
        const a = row * (columns + 1) + col,
          b = a + columns + 1
        indices.push(a, b, a + 1, a + 1, b, b + 1)
      }
    this.indexCount = indices.length
    this.indices = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW)
    this.texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic')
    if (anisotropy)
      gl.texParameterf(
        gl.TEXTURE_2D,
        anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(4, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number)
      )
    this.viewport = gl.getUniformLocation(program, 'viewport')
    this.alpha = gl.getUniformLocation(program, 'alpha')
    this.tear = gl.getUniformLocation(program, 'tear')
    this.textureScale = gl.getUniformLocation(program, 'textureScale')
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }

  private rasterize(width: number, height: number, dpr: number) {
    const gl = this.gl
    // Rasterize at the actual screen pixel density so glyph hinting matches the displayed size.
    // Pad the texture to powers of two; never stretch the content to fit those dimensions.
    const scale = Math.min(dpr, this.textureSize / width, this.textureSize / height)
    const rasterWidth = Math.max(1, Math.round(width * scale))
    const rasterHeight = Math.max(1, Math.round(height * scale))
    if (rasterWidth === this.rasterWidth && rasterHeight === this.rasterHeight) return
    this.rasterWidth = rasterWidth
    this.rasterHeight = rasterHeight
    if (this.pendingImage) {
      this.pendingImage.onload = null
      this.pendingImage.onerror = null
    }
    const svg = new DOMParser().parseFromString(
      decodeURIComponent(this.image.src.slice(this.image.src.indexOf(',') + 1)),
      'image/svg+xml'
    ).documentElement
    // Set intrinsic dimensions as well as drawing dimensions so SVG glyphs rasterize at the target size.
    svg.setAttribute('width', String(rasterWidth))
    svg.setAttribute('height', String(rasterHeight))
    const raster = new Image()
    this.pendingImage = raster
    raster.onload = () => {
      if (this.disposed || this.pendingImage !== raster) return
      const source = document.createElement('canvas')
      source.width = 2 ** Math.ceil(Math.log2(rasterWidth))
      source.height = 2 ** Math.ceil(Math.log2(rasterHeight))
      source.getContext('2d')!.drawImage(raster, 0, 0)
      gl.bindTexture(gl.TEXTURE_2D, this.texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.uniform2f(this.textureScale, rasterWidth / source.width, rasterHeight / source.height)
      source.width = source.height = 0
      this.textureReady = true
      this.invalidate()
    }
    raster.onerror = () => {
      if (!this.disposed) this.invalidate()
    }
    raster.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
  }

  draw(frame: PaperFrame, pose: PaperPose, opacity = 1) {
    const gl = this.gl
    const {
      width,
      height,
      originX,
      originY,
      canvasWidth: screenWidth,
      canvasHeight: screenHeight
    } = frame
    const dpr = Math.min(
      window.devicePixelRatio || 1,
      this.renderSize / Math.max(screenWidth, screenHeight)
    )
    this.rasterize(width, height, dpr)
    const pixelWidth = Math.round(screenWidth * dpr),
      pixelHeight = Math.round(screenHeight * dpr)
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth
      this.canvas.height = pixelHeight
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    }
    const hinge = width * (pose.side > 0 ? 0.12 : 0.88)
    const cos = Math.cos(pose.angle),
      sin = Math.sin(pose.angle)
    const tension = clamp(pose.lift, 0, 1)
    for (let row = 0; row <= rows; row++)
      for (let col = 0; col <= columns; col++) {
        const u = col / columns,
          v = row / rows
        const x = u * width,
          y = v * height
        const across = pose.side > 0 ? u : 1 - u
        const separated = smooth(1 - pose.peel - 0.055, 1 - pose.peel + 0.055, across)
        // Unbroken fibres stay in the slot. Only the first few centimetres bend around that anchor.
        const pin = (1 - smooth(0, 0.085, v)) * (1 - separated) * (1 - pose.release)
        const corner = Math.pow(smooth(0.78, 1, v), 2) * (Math.pow(u, 7) + Math.pow(1 - u, 7) * 0.4)
        const curl = corner * width * tension * 0.103
        const ripple =
          Math.sin(v * 9 - u * 2.3) * pose.flutter * width * 0.024 * Math.sin((v * Math.PI) / 2)
        const tip = Math.exp(-Math.pow((across - (1 - pose.peel)) / 0.1, 2) - Math.pow(v / 0.09, 2))
        const fold =
          Math.sin(Math.PI * clamp(v / 0.11, 0, 1)) *
          pin *
          width *
          (tension * 0.025 + pose.strain * 0.1)
        // Strain gathers at the remaining fibres rather than inflating the whole sheet.
        const z =
          Math.sin(v * Math.PI) * tension * width * 0.014 +
          curl +
          fold +
          ripple +
          tip * width * 0.045 * pose.strain
        // A fine irregular torn edge is revealed as the tear front travels toward the remaining corner.
        const fibres = (Math.sin(col * 2.71) + Math.sin(col * 5.19) * 0.55) * width * 0.0032
        const edge = row === 0 ? fibres * separated * Math.min(1, pose.peel * 4) : 0
        const bodyX = hinge + (x - hinge) * cos - y * sin + pose.x
        const bodyY = (x - hinge) * sin + y * cos + pose.pull + pose.y - curl * 0.3 + edge
        const px = bodyX * (1 - pin) + x * pin
        const py = bodyY * (1 - pin) + y * pin
        const index = (row * (columns + 1) + col) * 3
        this.points[index] = px
        this.points[index + 1] = py
        this.points[index + 2] = z * (1 - pin)
      }
    for (let row = 0; row <= rows; row++)
      for (let col = 0; col <= columns; col++) {
        const i = row * (columns + 1) + col,
          p = i * 3
        const left = (row * (columns + 1) + Math.max(0, col - 1)) * 3
        const right = (row * (columns + 1) + Math.min(columns, col + 1)) * 3
        const up = (Math.max(0, row - 1) * (columns + 1) + col) * 3
        const down = (Math.min(rows, row + 1) * (columns + 1) + col) * 3
        const ax = this.points[right] - this.points[left],
          ay = this.points[right + 1] - this.points[left + 1],
          az = this.points[right + 2] - this.points[left + 2]
        const bx = this.points[down] - this.points[up],
          by = this.points[down + 1] - this.points[up + 1],
          bz = this.points[down + 2] - this.points[up + 2]
        const nx = ay * bz - az * by,
          ny = az * bx - ax * bz,
          nz = ax * by - ay * bx
        const length = Math.hypot(nx, ny, nz) || 1
        const light = clamp(0.76 + (0.24 * nz - 0.28 * nx - 0.24 * ny) / length, 0.65, 1.1)
        const perspective = 1000 / (1000 - this.points[p + 2])
        const vertex = i * stride
        this.vertices[vertex] = originX + width / 2 + (this.points[p] - width / 2) * perspective
        this.vertices[vertex + 1] = originY + this.points[p + 1] * perspective
        this.vertices[vertex + 2] = col / columns
        this.vertices[vertex + 3] = row / rows
        this.vertices[vertex + 4] = light
      }
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.uniform2f(this.viewport, screenWidth, screenHeight)
    gl.uniform1f(this.alpha, opacity)
    gl.uniform3f(this.tear, pose.peel, pose.side, height)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertices)
    if (!this.textureReady) return false
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0)
    return true
  }

  pick(x: number, y: number): { u: number; v: number } | undefined {
    const check = (ia: number, ib: number, ic: number) => {
      const a = ia * stride,
        b = ib * stride,
        c = ic * stride,
        v = this.vertices
      const determinant =
        (v[b + 1] - v[c + 1]) * (v[a] - v[c]) + (v[c] - v[b]) * (v[a + 1] - v[c + 1])
      if (Math.abs(determinant) < 0.0001) return
      const wa = ((v[b + 1] - v[c + 1]) * (x - v[c]) + (v[c] - v[b]) * (y - v[c + 1])) / determinant
      const wb = ((v[c + 1] - v[a + 1]) * (x - v[c]) + (v[a] - v[c]) * (y - v[c + 1])) / determinant
      const wc = 1 - wa - wb
      if (wa < 0 || wb < 0 || wc < 0) return
      return {
        u: wa * v[a + 2] + wb * v[b + 2] + wc * v[c + 2],
        v: wa * v[a + 3] + wb * v[b + 3] + wc * v[c + 3]
      }
    }
    for (let row = rows - 1; row >= 0; row--)
      for (let col = 0; col < columns; col++) {
        const a = row * (columns + 1) + col,
          b = a + columns + 1
        const hit = check(a, b, a + 1) ?? check(a + 1, b, b + 1)
        if (hit) return hit
      }
  }

  dispose() {
    this.disposed = true
    if (this.pendingImage) {
      this.pendingImage.onload = null
      this.pendingImage.onerror = null
    }
    const gl = this.gl
    gl.deleteTexture(this.texture)
    gl.deleteBuffer(this.buffer)
    gl.deleteBuffer(this.indices)
    gl.deleteProgram(this.program)
  }
}
