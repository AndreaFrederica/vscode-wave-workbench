# 波形数学和频谱

在波形列表选中输入信号，打开顶部的「数学」菜单。可用 A/B 游标指定区间，也可计算整段。派生信号显示在原波形时间轴上，可以继续选作输入，并随波形工程保存采样结果。更改参数时，从源信号重新运行相应算子。

| 算子 | 配置 |
| --- | --- |
| 算式、微分、积分 | 按输入提示使用 A–D，支持模拟实数和数字总线混用。总线可按无符号或二补码解释。微分采用相邻采样的差分，积分采用零阶保持。 |
| 一阶低通 | 配置 Hz 截止频率和输出采样周期。滤波输入按零阶保持，并按输出周期计算 RC 响应。 |
| ADC | 配置范围下限、上限和 1–32 bit 分辨率。输出为饱和、最近码量化的无符号码。 |
| DAC | 输入 1–32 bit 无符号码，配置满量程和单位，输出为零阶保持的实数。 |
| FFT | 配置采样点数、窗函数、去直流和模拟重采样方式。输出幅值、相位、相对于 1 输入单位的 dB 和单边功率谱密度。 |
| 外部算子 | 选择本地 JavaScript 文件或 Native 可执行文件，并填写 JSON 参数。 |

算式支持 \`+ - * / % ^\`、括号、\`pi\`、\`e\`，以及 \`abs\`、\`sqrt\`、\`exp\`、\`ln\`、\`log10\`、\`sin\`、\`cos\`、\`tan\`、\`asin\`、\`acos\`、\`atan\`、\`atan2\`、\`min\`、\`max\`、\`hypot\`、\`pow\`、\`clamp\`、\`floor\`、\`ceil\`、\`round\`、\`sign\`。数据变化时计算新值，非有限结果以及参与运算的 X/Z 产生缺口。整数超出二进制浮点安全整数范围时，算式会产生缺口。数字拼接、位逻辑和位选择仍由数字信号工具提供。

## ADC 和 DAC 触发

单选数据输入时，可选随输入变化或固定周期。固定周期以区间左端为基准，周期、起始偏移和输出延迟均按原始 tick 输入。添加第二个输入即可使用外部触发。1 bit 触发输入可选上升沿、下降沿或双沿。实数触发按采样值跨越阈值判定，阈值也可配置。

触发 tick 上读取数字码或模拟值，若同一 tick 内有多次更新则使用最后一个已记录值。输出延迟只移动结果更新时间。触发前以及无效输入的输出为未知值。ADC 使用整数事件时钟，不依赖 A 游标所在位置。

## FFT 频谱

频谱以独立 RAW 文件打开。频率轴使用 Hz 或其 SI 倍数，横坐标与 FFT bin 一一对应，CSV 包含 \`frequency_hz\`。FFT 采用 \`[start, end)\` 的均匀采样网格，可选 Hann、Hamming、Blackman 和矩形窗。数字输入使用零阶保持。模拟输入可以选线性或零阶保持。线性插值在区间末尾缺少下一个采样点时保持末值。降采样前如需抑制混叠，可先用低通算子处理输入。

## 外部算子 API v1

JavaScript Worker 加载默认导出函数，接受一个对象并返回一个通道。Native 可执行文件从 stdin 读取同样的一个 JSON 对象，在 stdout 输出一个 JSON 通道，可把诊断写到 stderr。两种方式从可信工作区显式选择本地文件启动，执行超时为 15 秒。算子共享运行 VS Code 的用户权限。

\`\`\`ts
type Channel =
  | { kind: "real"; unit?: string; events: [string, string][] }
  | { kind: "digital"; width: number; events: [string, string][] };

interface Request {
  apiVersion: 1;
  start: string;
  end: string;
  secondsPerTick: number;
  inputs: Channel[];
  options: Record<string, unknown>;
}

type Operator = (request: Request) => Channel | Promise<Channel>;
\`\`\`

时间戳是十进制 tick 字符串，输出区间包含 \`start\` 和 \`end\`。输入允许在 \`start\` 之前带一条或多条用于建立初始状态的事件。输出必须严格递增，并位于请求区间内。实数使用十进制字符串或 \`NaN\`，数字使用固定宽度的小写 \`01xz\`。每次调用有一个独立的结果通道。Native 实现可以使用能读写 JSON 的任意语言。

JavaScript 增益算子可保存为 \`gain.mjs\`，参数填入 \`{"gain": 2}\`。

\`\`\`js
export default function gain({ apiVersion, start, end, inputs, options }) {
  const [input] = inputs;
  if (apiVersion !== 1 || input.kind !== "real") throw Error("Expected a real channel");
  const factor = Number(options.gain ?? 1);
  if (!Number.isFinite(factor)) throw Error("Invalid gain");

  const output = new Map();
  for (const [tick, raw] of input.events) {
    if (BigInt(tick) > BigInt(end)) break;
    const value = Number(raw) * factor;
    output.set(BigInt(tick) < BigInt(start) ? start : tick,
      Number.isFinite(value) ? String(value) : "NaN");
  }
  return { kind: "real", unit: input.unit, events: [...output] };
}
\`\`\`
