import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const colors = {
  amber: [1, 0.647, 0.153, 1],
  amberLight: [1, 0.969, 0.894, 1],
  blue: [0, 0.42, 0.827, 1],
  blueLight: [0.933, 0.969, 1, 1],
  green: [0.133, 0.663, 0.478, 1],
  greenLight: [0.929, 0.98, 0.961, 1],
  line: [0.812, 0.898, 0.98, 1],
  muted: [0.91, 0.945, 0.973, 1],
  red: [0.91, 0.267, 0.286, 1],
  white: [1, 1, 1, 1],
};

const transform = {
  ty: 'tr',
  p: { a: 0, k: [0, 0] },
  a: { a: 0, k: [0, 0] },
  s: { a: 0, k: [100, 100] },
  r: { a: 0, k: 0 },
  o: { a: 0, k: 100 },
  sk: { a: 0, k: 0 },
  sa: { a: 0, k: 0 },
};

function fill(color) {
  return { ty: 'fl', c: { a: 0, k: color }, o: { a: 0, k: 100 }, r: 1 };
}

function stroke(color, width = 6) {
  return { ty: 'st', c: { a: 0, k: color }, o: { a: 0, k: 100 }, w: { a: 0, k: width }, lc: 2, lj: 2 };
}

function ellipse(size, position, color, strokeColor, strokeWidth = 0) {
  return {
    ty: 'gr',
    it: [
      { d: 1, ty: 'el', s: { a: 0, k: size }, p: { a: 0, k: position } },
      ...(color ? [fill(color)] : []),
      ...(strokeColor ? [stroke(strokeColor, strokeWidth)] : []),
      transform,
    ],
  };
}

function rectangle(size, position, radius, color, strokeColor, strokeWidth = 0) {
  return {
    ty: 'gr',
    it: [
      { d: 1, ty: 'rc', s: { a: 0, k: size }, p: { a: 0, k: position }, r: { a: 0, k: radius } },
      fill(color),
      ...(strokeColor ? [stroke(strokeColor, strokeWidth)] : []),
      transform,
    ],
  };
}

function path(points, { color, strokeColor, strokeWidth = 0, closed = true }) {
  const zero = points.map(() => [0, 0]);
  return {
    ty: 'gr',
    it: [
      {
        ty: 'sh',
        ks: { a: 0, k: { i: zero, o: zero, v: points, c: closed } },
      },
      ...(color ? [fill(color)] : []),
      ...(strokeColor ? [stroke(strokeColor, strokeWidth)] : []),
      transform,
    ],
  };
}

function animatedKeyframes(frames) {
  return frames.map(({ t, s }, index) => {
    if (index === frames.length - 1) return { t, s };

    return {
      i: { x: [0.5], y: [1] },
      o: { x: [0.5], y: [0] },
      t,
      s,
    };
  });
}

function animatedProperty(fallback, frames) {
  return frames
    ? { a: 1, k: animatedKeyframes(frames) }
    : { a: 0, k: fallback };
}

function layer(name, shapes, {
  opacity,
  position,
  positionFrames,
  rotation,
  rotationFrames,
  scale,
  scaleFrames,
} = {}) {
  return {
    ddd: 0,
    ind: 1,
    ty: 4,
    nm: name,
    sr: 1,
    ks: {
      o: animatedProperty(100, opacity),
      r: animatedProperty(rotation ?? 0, rotationFrames),
      p: animatedProperty(position ?? [256, 256, 0], positionFrames),
      a: { a: 0, k: [0, 0, 0] },
      s: animatedProperty(scale ?? [250, 250, 100], scaleFrames),
    },
    ao: 0,
    // Shape groups follow the same top-first stacking rule as layers.
    shapes: [...shapes].reverse(),
    ip: 0,
    op: 180,
    st: 0,
    bm: 0,
  };
}

const bolt = path([[8, -48], [-30, 4], [-5, 4], [-14, 48], [32, -14], [5, -14]], { color: colors.blue });
const whiteBolt = path([[8, -48], [-30, 4], [-5, 4], [-14, 48], [32, -14], [5, -14]], { color: colors.white });
const check = path([[-24, 0], [-7, 17], [27, -17]], { strokeColor: colors.white, strokeWidth: 9, closed: false });
const smallBolt = path([[4, -24], [-15, 2], [-2, 2], [-7, 24], [16, -7], [3, -7]], { color: colors.white });
const shield = path([[0, -54], [46, -37], [46, -5], [35, 30], [0, 53], [-35, 30], [-46, -5], [-46, -37]], { color: colors.blue });
const sparkle = path([[0, -16], [5, -5], [16, 0], [5, 5], [0, 16], [-5, 5], [-16, 0], [-5, -5]], { color: colors.blue });
const document = [
  path([[-42, -52], [18, -52], [42, -28], [42, 52], [-42, 52]], { color: colors.white, strokeColor: colors.line, strokeWidth: 4 }),
  path([[18, -52], [18, -28], [42, -28]], { color: colors.blueLight, strokeColor: colors.line, strokeWidth: 4 }),
  path([[-23, -13], [23, -13]], { strokeColor: colors.blue, strokeWidth: 6, closed: false }),
  path([[-23, 5], [15, 5]], { strokeColor: colors.line, strokeWidth: 6, closed: false }),
  path([[-23, 23], [5, 23]], { strokeColor: colors.line, strokeWidth: 6, closed: false }),
];
const receipt = [
  path([[-44, -54], [44, -54], [44, 48], [33, 57], [22, 48], [11, 57], [0, 48], [-11, 57], [-22, 48], [-33, 57], [-44, 48]], { color: colors.white, strokeColor: colors.line, strokeWidth: 4 }),
  path([[-24, -25], [24, -25]], { strokeColor: colors.blue, strokeWidth: 7, closed: false }),
  path([[-24, -3], [24, -3]], { strokeColor: colors.line, strokeWidth: 6, closed: false }),
  path([[-24, 19], [8, 19]], { strokeColor: colors.line, strokeWidth: 6, closed: false }),
];
const wallet = [
  rectangle([104, 76], [0, 6], 18, colors.white, colors.line, 4),
  rectangle([48, 34], [35, 6], 10, colors.blueLight, colors.blue, 4),
  ellipse([10, 10], [30, 6], colors.blue),
];
const transactionCard = [
  rectangle([104, 68], [0, 0], 18, colors.white, colors.line, 4),
  ellipse([28, 28], [-28, 0], colors.blue),
  smallBolt,
  path([[4, -10], [31, -10]], { strokeColor: colors.blue, strokeWidth: 6, closed: false }),
  path([[4, 10], [24, 10]], { strokeColor: colors.line, strokeWidth: 6, closed: false }),
];

const loopScale = [
  { t: 0, s: [242, 242, 100] },
  { t: 90, s: [255, 255, 100] },
  { t: 180, s: [242, 242, 100] },
];
const floatPosition = [
  { t: 0, s: [256, 270, 0] },
  { t: 90, s: [256, 242, 0] },
  { t: 180, s: [256, 270, 0] },
];

function halo(color = colors.blueLight) {
  return layer('halo', [ellipse([150, 150], [0, 0], color)], { scaleFrames: loopScale });
}

function particle(name, position, color, delay = 0) {
  return layer(name, [ellipse([18, 18], [0, 0], color)], {
    position,
    scale: [100, 100, 100],
    scaleFrames: [
      { t: 0, s: [35, 35, 100] },
      { t: 30 + delay, s: [35, 35, 100] },
      { t: 70 + delay, s: [125, 125, 100] },
      { t: 110 + delay, s: [35, 35, 100] },
      { t: 180, s: [35, 35, 100] },
    ],
  });
}

const visuals = {
  welcome: [
    halo(),
    layer('energy-core', [ellipse([104, 104], [0, 0], colors.white, colors.line, 4), bolt], {
      positionFrames: floatPosition,
      scaleFrames: loopScale,
    }),
    particle('spark-left', [153, 205, 0], colors.green),
    particle('spark-right', [357, 190, 0], colors.amber, 25),
    layer('orbit', [sparkle], {
      position: [350, 318, 0],
      scale: [90, 90, 100],
      rotationFrames: [{ t: 0, s: [0] }, { t: 180, s: [360] }],
    }),
  ],
  attention: [
    halo(colors.amberLight),
    layer('document', document, {
      positionFrames: [{ t: 0, s: [256, 286, 0] }, { t: 55, s: [256, 250, 0] }, { t: 180, s: [256, 250, 0] }],
      scaleFrames: [{ t: 0, s: [220, 220, 100] }, { t: 55, s: [250, 250, 100] }, { t: 180, s: [250, 250, 100] }],
    }),
    layer('attention-badge', [ellipse([48, 48], [0, 0], colors.amber, colors.white, 5), path([[0, -13], [0, 5]], { strokeColor: colors.white, strokeWidth: 7, closed: false }), ellipse([7, 7], [0, 16], colors.white)], {
      position: [348, 338, 0],
      scaleFrames: [{ t: 0, s: [55, 55, 100] }, { t: 55, s: [125, 125, 100] }, { t: 80, s: [100, 100, 100] }, { t: 180, s: [100, 100, 100] }],
    }),
  ],
  receipt: [
    halo(),
    layer('receipt', receipt, {
      positionFrames: [{ t: 0, s: [256, 300, 0] }, { t: 60, s: [256, 248, 0] }, { t: 180, s: [256, 248, 0] }],
    }),
    layer('paid', [ellipse([42, 42], [0, 0], colors.green, colors.white, 5), check], {
      position: [344, 334, 0],
      scaleFrames: [{ t: 0, s: [30, 30, 100] }, { t: 65, s: [30, 30, 100] }, { t: 100, s: [115, 115, 100] }, { t: 125, s: [100, 100, 100] }, { t: 180, s: [100, 100, 100] }],
    }),
  ],
  success: [
    halo(colors.greenLight),
    layer('success-core', [ellipse([104, 104], [0, 0], colors.green), check], {
      scaleFrames: [{ t: 0, s: [130, 130, 100] }, { t: 50, s: [270, 270, 100] }, { t: 75, s: [245, 245, 100] }, { t: 180, s: [245, 245, 100] }],
    }),
    particle('success-spark-left', [151, 208, 0], colors.blue, 10),
    particle('success-spark-right', [361, 195, 0], colors.amber, 35),
  ],
  token: [
    halo(),
    layer('token', [ellipse([112, 112], [0, 0], colors.blue, colors.white, 5), smallBolt], {
      positionFrames: floatPosition,
      rotationFrames: [{ t: 0, s: [-5] }, { t: 90, s: [5] }, { t: 180, s: [-5] }],
    }),
    layer('token-orbit', [ellipse([150, 150], [0, 0], null, colors.line, 3), ellipse([18, 18], [75, 0], colors.green)], {
      rotationFrames: [{ t: 0, s: [0] }, { t: 180, s: [360] }],
    }),
  ],
  happy: [
    halo(colors.greenLight),
    layer('happy-core', [ellipse([104, 104], [0, 0], colors.green), path([[-28, 5], [-15, 20], [0, 27], [15, 20], [28, 5]], { strokeColor: colors.white, strokeWidth: 8, closed: false }), ellipse([8, 8], [-22, -14], colors.white), ellipse([8, 8], [22, -14], colors.white)], {
      scaleFrames: loopScale,
    }),
    particle('happy-confetti-a', [148, 192, 0], colors.blue),
    particle('happy-confetti-b', [365, 218, 0], colors.amber, 20),
    particle('happy-confetti-c', [182, 355, 0], colors.red, 40),
  ],
  empty: [
    halo(),
    layer('wallet', wallet, { position: [240, 270, 0], scale: [230, 230, 100] }),
    layer('search', [ellipse([54, 54], [0, 0], colors.white, colors.blue, 6), path([[18, 18], [39, 39]], { strokeColor: colors.blue, strokeWidth: 8, closed: false })], {
      positionFrames: [{ t: 0, s: [330, 190, 0] }, { t: 90, s: [350, 220, 0] }, { t: 180, s: [330, 190, 0] }],
      scale: [150, 150, 100],
      rotationFrames: [{ t: 0, s: [-8] }, { t: 90, s: [6] }, { t: 180, s: [-8] }],
    }),
  ],
  build: [
    halo(),
    layer('block-left', [rectangle([44, 44], [0, 0], 10, colors.blueLight, colors.blue, 4)], {
      positionFrames: [{ t: 0, s: [198, 350, 0] }, { t: 55, s: [198, 286, 0] }, { t: 180, s: [198, 286, 0] }],
      scale: [180, 180, 100],
    }),
    layer('block-center', [rectangle([44, 44], [0, 0], 10, colors.blue, colors.blue, 4), smallBolt], {
      positionFrames: [{ t: 0, s: [256, 350, 0] }, { t: 30, s: [256, 350, 0] }, { t: 85, s: [256, 228, 0] }, { t: 180, s: [256, 228, 0] }],
      scale: [180, 180, 100],
    }),
    layer('block-right', [rectangle([44, 44], [0, 0], 10, colors.greenLight, colors.green, 4)], {
      positionFrames: [{ t: 0, s: [314, 350, 0] }, { t: 60, s: [314, 350, 0] }, { t: 115, s: [314, 286, 0] }, { t: 180, s: [314, 286, 0] }],
      scale: [180, 180, 100],
    }),
    particle('build-spark', [352, 178, 0], colors.amber, 55),
  ],
  wait: [
    halo(),
    layer('wait-ring', [ellipse([130, 130], [0, 0], colors.white, colors.line, 5), ellipse([20, 20], [65, 0], colors.blue)], {
      rotationFrames: [{ t: 0, s: [0] }, { t: 180, s: [360] }],
    }),
    layer('wait-bolt', [bolt], { scaleFrames: loopScale }),
    particle('wait-dot-a', [180, 350, 0], colors.blue),
    particle('wait-dot-b', [256, 350, 0], colors.blue, 20),
    particle('wait-dot-c', [332, 350, 0], colors.blue, 40),
  ],
  launch: [
    halo(),
    layer('trail-a', [path([[-40, 0], [40, 0]], { strokeColor: colors.line, strokeWidth: 7, closed: false })], {
      position: [180, 300, 0], scale: [130, 130, 100],
    }),
    layer('trail-b', [path([[-30, 0], [30, 0]], { strokeColor: colors.blueLight, strokeWidth: 7, closed: false })], {
      position: [170, 330, 0], scale: [130, 130, 100],
    }),
    layer('transaction', transactionCard, {
      positionFrames: [{ t: 0, s: [190, 280, 0] }, { t: 70, s: [286, 238, 0] }, { t: 120, s: [270, 248, 0] }, { t: 180, s: [286, 238, 0] }],
      rotationFrames: [{ t: 0, s: [-7] }, { t: 70, s: [4] }, { t: 120, s: [0] }, { t: 180, s: [4] }],
      scale: [210, 210, 100],
    }),
  ],
  celebrate: [
    halo(colors.greenLight),
    layer('celebrate-core', [ellipse([106, 106], [0, 0], colors.blue), whiteBolt], {
      scaleFrames: [{ t: 0, s: [80, 80, 100] }, { t: 55, s: [270, 270, 100] }, { t: 85, s: [245, 245, 100] }, { t: 180, s: [245, 245, 100] }],
      rotationFrames: [{ t: 0, s: [-12] }, { t: 55, s: [8] }, { t: 85, s: [0] }, { t: 180, s: [0] }],
    }),
    particle('celebrate-a', [145, 175, 0], colors.amber),
    particle('celebrate-b', [370, 190, 0], colors.green, 15),
    particle('celebrate-c', [152, 350, 0], colors.red, 30),
    particle('celebrate-d', [360, 344, 0], colors.blue, 45),
  ],
  guard: [
    halo(),
    layer('shield', [shield, rectangle([42, 34], [0, 12], 8, colors.white), path([[-13, -5], [-13, -16], [0, -27], [13, -16], [13, -5]], { strokeColor: colors.white, strokeWidth: 6, closed: false })], {
      scaleFrames: [{ t: 0, s: [210, 210, 100] }, { t: 55, s: [260, 260, 100] }, { t: 80, s: [245, 245, 100] }, { t: 180, s: [245, 245, 100] }],
    }),
    layer('security-scan', [rectangle([94, 8], [0, 0], 4, colors.green)], {
      positionFrames: [{ t: 0, s: [256, 200, 0] }, { t: 90, s: [256, 312, 0] }, { t: 180, s: [256, 200, 0] }],
      scale: [100, 100, 100],
      opacity: [{ t: 0, s: [0] }, { t: 25, s: [100] }, { t: 155, s: [100] }, { t: 180, s: [0] }],
    }),
  ],
};

function composition(name, layers) {
  return {
    v: '5.7.4', fr: 60, ip: 0, op: 180, w: 512, h: 512,
    nm: `Legends Wallet ${name}`, ddd: 0, assets: [],
    // Lottie stores the topmost layer first. Visual declarations are written background-first,
    // so reverse them before serialization to keep the halo behind the semantic artwork.
    layers: [...layers].reverse().map((item, index) => ({ ...item, ind: index + 1 })),
  };
}

const targets = {
  welcome: ['src/assets/lottie/legends_welcome.tgs'],
  attention: [
    'src/assets/lottie/legends_attention.tgs',
    'mobile/android/air/SubModules/UIComponents/src/main/res/raw/animation_snitch.tgs',
    'mobile/ios/Air/SubModules/WalletResources/Resources/Animations/animation_snitch.tgs',
  ],
  success: [
    'src/assets/lottie/legends_success.tgs',
    'mobile/android/air/SubModules/UIComponents/src/main/res/raw/animation_thumb.tgs',
    'mobile/ios/Air/SubModules/WalletResources/Resources/Animations/duck_thumb.tgs',
  ],
  receipt: [
    'src/assets/lottie/legends_receipt.tgs',
    'mobile/android/air/SubModules/UIComponents/src/main/res/raw/animation_bill.tgs',
    'mobile/ios/Air/SubModules/WalletResources/Resources/Animations/animation_bill.tgs',
  ],
  token: ['src/assets/lottie/legends_token.tgs'],
  happy: [
    'src/assets/lottie/legends_happy.tgs',
    'mobile/android/air/SubModules/UIComponents/src/main/res/raw/animation_happy.tgs',
    'mobile/ios/Air/SubModules/WalletResources/Resources/Animations/animation_happy.tgs',
  ],
  build: ['src/assets/lottie/legends_build.tgs'],
  wait: [
    'src/assets/lottie/legends_progress.tgs',
    'mobile/android/air/SubModules/UIComponents/src/main/res/raw/animation_wait.tgs',
    'mobile/ios/Air/SubModules/WalletResources/Resources/Animations/duck_wait.tgs',
  ],
  launch: ['src/assets/lottie/legends_launch.tgs'],
  celebrate: ['src/assets/lottie/legends_celebrate.tgs'],
  guard: [
    'src/assets/lottie/legends_security.tgs',
    'mobile/android/air/SubModules/UIComponents/src/main/res/raw/animation_guard.tgs',
    'mobile/ios/Air/SubModules/WalletResources/Resources/Animations/animation_guard.tgs',
  ],
  empty: [
    'src/assets/lottie/legends_empty.tgs',
    'mobile/android/air/SubModules/UIComponents/src/main/res/raw/animation_empty.tgs',
    'mobile/ios/Air/SubModules/WalletResources/Resources/Animations/duck_no-data.tgs',
  ],
};

for (const [name, paths] of Object.entries(targets)) {
  const json = composition(name, visuals[name]);
  const compressed = gzipSync(JSON.stringify(json), { level: 9, mtime: 0 });
  for (const path of paths) {
    const output = resolve(root, path);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, compressed);
  }
  if (name === 'welcome') {
    writeFileSync(resolve(root, 'mobile/shared/legends-status.lottie.json'), `${JSON.stringify(json, null, 2)}\n`);
  }
}
