# Paper Repro Agent · 精致研究工作台 / Refined research workbench

## Direction & Layout
采用深墨侧栏与冷灰纸张档案的研究仪器视觉：首屏以大尺度标题、实体管线控制面板和不对称论文档案构成辨识度，不再使用三张同等权重的通用图标卡片。 / An ink-dark rail and cool paper archive establish a research-instrument identity: a generous headline, physical-looking pipeline console and asymmetric paper dossiers replace equal-weight icon cards.
桌面侧栏 240px，内容最大宽度 1280px，内边距 48px；主论文占左列和两行，右列两篇紧凑档案。记录表为单一数据表面，指南采用纵向编号步骤。≤1100px 内容内边距 30px；≤1000px 侧栏转为顶部导航；≤700px 论文档案单列，标题 36px，内边距 20px。 / Desktop uses a 240px rail, 1280px content maximum and 48px padding. The lead paper spans the left column and two rows, with two concise dossiers on the right. History remains one data surface; the guide becomes numbered rows. Breakpoints simplify without hiding controls.
遵循已检查的项目五阶段流程，不增业务功能。不使用泛滥渐变、玻璃模糊、发光边框、彩色图标格子或模板化重复卡片。 / Follow the inspected five-stage pipeline without adding functionality. No decorative gradients, glass blur, glowing borders or colored icon grids.

## Tokens
背景 #edf0ef，纸张 #fcfcfa，侧栏 #182622，主字 #24342e，次字 #65716b，强调 #245741，黄铜细节 #b9a47b。成功 #276544 / #edf4ef，警示 #806026 / #f7f0e3。 / Cool neutral paper surfaces, ink typography, restrained pine controls and sparse brass details.
界面字体：系统 SF/Segoe UI/PingFang SC/Microsoft YaHei；英文主标题 56px/1.08、字重 500，中文 48px/1.25、字重 500；论文名用 Georgia/Times 衬线 28–44px，中文界面仍保留原题；正文 13–14px/1.7，次级文案不低于 11px。 / System humanist UI type, large restrained headings, serif original paper names and readable captions.
间距 4/8/12/16/24/32/48px，表面圆角 8–12px，按钮 6px。1px #d7ded9 边框，纸张层叠 0 1px 2px #1528200a 和 0 12px 28px #1528200a；侧栏窄内高光，档案底部露出第二纸层，控制按钮轻内高光。 / Borders, layered low-opacity shadows and restrained inset highlights provide depth without spectacle.

## Shared Patterns & States
侧栏：深墨底、亮字、嵌入式当前项；论文档案：编号、学科、原题、资源类型、目标和真实回放入口；记录表：足够对比、行悬停提示；回放：深色标题控制栏、浅色纸张和证据面板，契约与结论原文保留。指南编号纵向排列，避免额外卡片堆砌。 / Rail, dossier, history table and replay console share one material system; evidence remains unchanged.
按钮至少 40px；悬停 160ms ease 改变边框/阴影，主回放按钮深绿白字；禁用状态保留语义；焦点为 2px #458365。无内容入场隐藏和持续动画，prefers-reduced-motion 关闭转换。语言入口在主页面和弹窗均明显可用。 / Visible focus, contrast, reduced-motion support and persistent bilingual controls.

## Media
无需营销图片。真实论文 PDF 与录制日志是核心内容，继续复用已有本地资产，不生成伪科研图像、不改原始数据。论文档案采用真实标题与目标排版而非装饰图片。 / Real PDFs and recordings are the media; typography carries paper identity, with no invented scientific imagery.
