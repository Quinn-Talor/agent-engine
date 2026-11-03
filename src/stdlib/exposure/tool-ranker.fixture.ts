// 工具检索的评测语料：一个 Tushare MCP 服务器的 49 个真实工具加一个只有英文描述的插件天气工具
// （名字、能力 id、描述都取自 Talor 运行档案原样）。查询与期望命中见 tool-ranker.eval.test.ts。

import type { ToolCandidate } from './tool-ranker.js'

export const EVAL_TOOLS: readonly ToolCandidate[] = [
  {
    name: 'tu-share__fund_daily',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/ETF专题/ETF日线行情-获取ETF行情每日收盘后成交数据，历史超过10年。单次最多返回 5000 条。更新：每日18点左右。参数约束：ts_code和trade_date至少填写一个',
  },
  {
    name: 'tu-share__rt_min_daily',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/行情数据/A股实时分钟-日累计-获取A股当日盘中历史分钟数据，可以提取单只股票当日开盘以来的所有分钟数据。单次最多返回 2000 条。更新：盘中实时更新当日历史',
  },
  {
    name: 'tu-share__stk_auction_c',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/特色数据/股票收盘集合竞价数据-股票收盘15:00集合竞价数据，每天盘后更新。单次最多返回 10000 条。更新：每日20点更新',
  },
  {
    name: 'tu-share__daily',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/行情数据/历史日线-获取股票行情数据，或通过[通用行情接口pro_bar]获取数据，包含了前后复权数据。单次最多返回 6000 条。更新：每个交易日16~17点之间',
  },
  {
    name: 'tu-share__stk_mins',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/行情数据/历史分钟-获取A股分钟数据，支持1min/5min/15min/30min/60min行情，提供Python SDK和 http Restful API两种方式。单次最多返回 8000 条。更新：每日19~20点之间',
  },
  {
    name: 'tu-share__stock_st',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/基础数据/ST股票列表-获取ST股票列表，可根据交易日期获取历史上每天的ST股票列表。单次最多返回 1000 条。更新：每日早9:30，晚9:30',
  },
  {
    name: 'tu-share__us_daily',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/美股数据/美股日线行情-获取美股行情（未复权），包括全部股票全历史行情，以及重要的市场和估值指标。单次最多返回 8000 条。更新：交易日13点',
  },
  {
    name: 'tu-share__etf_share_size',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/ETF专题/ETF份额规模-获取沪深ETF每日份额和规模数据，能体现规模份额的变化，掌握ETF资金动向，同时提供每日净值和收盘价；数据指标是分批入库，建议在每日19点后提取；另外，涉及海外的ETF数据更新会晚一些属于正常情况。单次最多返回 5000 条。更新：每日8:35更新',
  },
  {
    name: 'tu-share__dc_daily',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/打板专题数据/DC概念板块行情-获取东财概念板块、行业指数板块、地域板块行情数据，历史数据开始于2020年。单次最多返回 2000 条。更新：交易日20点30',
  },
  {
    name: 'tu-share__cashflow',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/财务数据/现金流量表-获取上市公司现金流量表。单次最多返回 100 条。更新：财报披露当晚21~23点，最晚次日',
  },
  {
    name: 'tu-share__cashflow_vip',
    capability: 'mcp:tu-share',
    description: '/数据接口/沪深股票/财务数据/现金流量表-现金流量表（VIP）。单次最多返回 6400 条',
  },
  {
    name: 'tu-share__income',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/财务数据/利润表-获取上市公司财务利润表数据。单次最多返回 500 条。更新：财报披露当日晚21点，最晚次日',
  },
  {
    name: 'tu-share__hk_cashflow',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/港股数据/港股现金流量表-获取港股上市公司现金流量表数据。单次最多返回 10000 条。更新：交易日9:00',
  },
  {
    name: 'tu-share__income_vip',
    capability: 'mcp:tu-share',
    description: '/数据接口/沪深股票/财务数据/利润表-利润表（VIP）。单次最多返回 9000 条',
  },
  {
    name: 'tu-share__us_cashflow',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/美股数据/美股现金流量表-获取美股上市公司现金流量表数据（目前只覆盖主要美股和中概股）。单次最多返回 10000 条。更新：交易日9点',
  },
  {
    name: 'tu-share__fina_indicator',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/财务数据/财务指标数据-获取上市公司财务指标数据，为避免服务器压力，现阶段每次请求最多返回100条记录，可通过设置日期多次请求获取更多数据。单次最多返回 100 条。更新：随财报披露T+1入库',
  },
  {
    name: 'tu-share__fina_indicator_vip',
    capability: 'mcp:tu-share',
    description: '/数据接口/沪深股票/财务数据/财务指标数据-财务指标（VIP）。单次最多返回 12000 条',
  },
  {
    name: 'tu-share__rt_k',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/行情数据/实时日线-获取实时日k线行情，支持按股票代码及股票代码通配符一次性提取全部股票实时日k线行情。单次最多返回 6000 条。更新：盘中实时更新',
  },
  {
    name: 'tu-share__rt_hk_k',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/港股数据/港股实时日线-获取港股实时日k线行情，支持按股票代码及股票代码通配符一次性提取全部股票实时日k线行情。单次最多返回 5000 条。更新：交易日实时更新9:00开始',
  },
  {
    name: 'tu-share__rt_etf_k',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/ETF专题/ETF实时日线-获取ETF实时日k线行情，支持按ETF代码或代码通配符一次性提取全部ETF实时日k线行情。单次最多返回 2000 条。更新：盘中实时更新',
  },
  {
    name: 'tu-share__rt_etf_min',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/ETF专题/ETF实时分钟-获取ETF实时分钟数据，包括1~60min。单次最多返回 1000 条。更新：盘中按1~60min实时更新',
  },
  {
    name: 'tu-share__rt_min',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/行情数据/实时分钟-获取全A股票实时分钟数据，包括1~60min。单次最多返回 1000 条。更新：按1~60分钟频度实时更新',
  },
  {
    name: 'tu-share__rt_etf_sz_iopv',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/ETF专题/ETF实时参考-ETF实时净值和申购赎回数据参考，目前只提供深市。单次最多返回 5000 条。更新：盘中实时更新',
  },
  {
    name: 'tu-share__rt_idx_k',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/指数专题/指数实时日线-获取交易所指数实时日线行情，支持按代码或代码通配符一次性提取全部交易所指数实时日k线行情。单次最多返回 1000 条。更新：盘中实时更新',
  },
  {
    name: 'tu-share__rt_fut_min',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/期货数据/实时分钟行情-获取全市场期货合约实时分钟数据，支持1min/5min/15min/30min/60min行情，提供Python SDK、 http Restful API和websocket三种方式。单次最多返回 1000 条。更新：实时',
  },
  {
    name: 'tu-share__forecast_vip',
    capability: 'mcp:tu-share',
    description: '/数据接口/沪深股票/财务数据/业绩预告-业绩预告（VIP）。单次最多返回 6500 条',
  },
  {
    name: 'tu-share__forecast',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/财务数据/业绩预告-获取业绩预告数据。单次最多返回 3500 条。更新：每日20点~21点更新。参数约束：ann_date和ts_code至少输入一个参数',
  },
  {
    name: 'tu-share__wz_index',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/宏观经济/国内宏观/利率数据/温州民间借贷利率-温州民间借贷利率，即温州指数。单次最多返回 3000 条。更新：每日不定期更新',
  },
  {
    name: 'tu-share__fut_trade_param_gfe',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/期货数据/广州期货交易参数-获取广州期货交易参数数据。单次最多返回 5000 条。更新：交易日20点更新',
  },
  {
    name: 'tu-share__gz_index',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/宏观经济/国内宏观/利率数据/广州民间借贷利率-广州民间借贷利率。单次最多返回 2000 条。更新：每日不定期更新',
  },
  {
    name: 'tu-share__cn_pmi',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/宏观经济/国内宏观/景气度/采购经理指数（PMI）-采购经理人指数。单次最多返回 2000 条。更新：每月更新一次',
  },
  {
    name: 'tu-share__hk_income',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/港股数据/港股利润表-获取港股上市公司财务利润表数据。单次最多返回 10000 条。更新：交易日9:00',
  },
  {
    name: 'tu-share__us_income',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/美股数据/美股利润表-获取美股上市公司财务利润表数据（目前只覆盖主要美股和中概股）。单次最多返回 10000 条。更新：交易日9点',
  },
  {
    name: 'tu-share__cn_cpi',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/宏观经济/国内宏观/价格指数/居民消费价格指数（CPI）-获取CPI居民消费价格数据，包括全国、城市和农村的数据。单次最多返回 5000 条。更新：每月更新',
  },
  {
    name: 'tu-share__top10_holders',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/市场参考数据/前十大股东-获取上市公司前十大股东数据，包括持有数量和比例等信息。单次最多返回 6000 条。更新：随财报披露日期当晚，最晚T+1入库',
  },
  {
    name: 'tu-share__top10_floatholders',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/参考数据/前十大流通股东-获取上市公司前十大流通股东数据。单次最多返回 6000 条。更新：随季报披露当日晚更新',
  },
  {
    name: 'tu-share__cb_factor_pro',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/债券专题/可转债技术面因子(专业版）-获取可转债每日技术面因子数据，用于跟踪可转债当前走势情况，数据由Tushare社区自产，覆盖全历史；输出参数_bfq表示不复权，_qfq表示前复权 _hfq表示后复权。单次最多返回 10000 条。更新：每日20:30左右。参数约束：ts_code,trade_date至少输入一个参数',
  },
  {
    name: 'tu-share__margin_secs',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/两融及转融通/融资融券标的（盘前）-获取沪深京三大交易所融资融券标的（包括ETF），每天盘前更新。单次最多返回 6000 条。更新：每日8:30更新当日标的',
  },
  {
    name: 'tu-share__ggt_top10',
    capability: 'mcp:tu-share',
    description:
      '获取港股通每日成交数据，其中包括沪市、深市详细数据，每天18~20点之间完成当日更新。单次最多返回 300 条。更新：每日18:30~19:30之间。参数约束：ts_code：当 trade_date 为空时必填',
  },
  {
    name: 'tu-share__stk_factor_pro',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/特色数据/股票技术面因子(专业版）-获取股票每日技术面因子数据，用于跟踪股票当前走势情况，数据由Tushare社区自产，覆盖全历史；输出参数_bfq表示不复权，_qfq表示前复权 _hfq表示后复权。单次最多返回 10000 条。更新：每个交易日19~20点之间。参数约束：ts_code,trade_date至少输入一个参数',
  },
  {
    name: 'tu-share__p_delete',
    capability: 'mcp:tu-share',
    description: '/数据接口/自选组合/组合删除-删除自选股组合。单次最多返回 200 条',
  },
  {
    name: 'tu-share__eco_cal',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/债券/全球财经事件-获取全球财经日历、包括经济事件数据更新。单次最多返回 100 条。更新：每日不定期更新',
  },
  {
    name: 'tu-share__cctv_news',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/大模型语料专题数据/新闻联播文字稿-获取新闻联播文字稿数据，数据开始于2017年。单次最多返回 100 条。更新：每天22点第30分钟',
  },
  {
    name: 'tu-share__npr',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/大模型语料专题数据/国家政策库-获取国家行政机关公开披露的各类法规、条例政策、批复、通知等文本数据。单次最多返回 500 条。更新：每天8、15点50分',
  },
  {
    name: 'tu-share__limit_step',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/沪深股票/打板专题数据/涨停股票连板天梯-获取每天连板个数晋级的股票，可以分析出每天连续涨停进阶个数，判断强势热度。单次最多返回 2000 条。更新：交易日16点',
  },
  {
    name: 'tu-share__index_weight',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/指数专题/指数成分和权重-获取各类指数成分和权重，**月度数据** ，建议输入参数里开始日期和结束日分别输入当月第一天和最后一天的日期。单次最多返回 7000 条。更新：每月最后一天19:00。参数约束：index_code：当 trade_date 为空时必填',
  },
  {
    name: 'tu-share__index_basic',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/指数/指数基本信息-获取指数基础信息。单次最多返回 8000 条。更新：每天18点更新',
  },
  {
    name: 'tu-share__p_get',
    capability: 'mcp:tu-share',
    description: '/数据接口/自选组合/成分查询-查询组合的成分列表。单次最多返回 3000 条',
  },
  {
    name: 'tu-share__p_list',
    capability: 'mcp:tu-share',
    description:
      '/数据接口/自选组合/组合列表-自选股组合查询，不加参数查询出所有自定义组合。单次最多返回 200 条',
  },
  {
    name: 'plugin_e2e-probe_weather__get_weather',
    capability: 'mcp:plugin_e2e-probe_weather',
    description: 'Get the current weather of a city',
  },
]
