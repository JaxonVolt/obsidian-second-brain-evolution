declare module 'lunar-javascript' {
  export interface LunarDate {
    getDayInChinese(): string;
    getDayJi(): string[];
    getDayYi(): string[];
    getFestivals(): string[];
    getJieQi(): string;
    getMonthInChinese(): string;
  }

  export interface SolarDate {
    getFestivals(): string[];
    getLunar(): LunarDate;
    getWeekInChinese(): string;
    next(days: number): SolarDate;
  }

  export const Solar: {
    fromYmd(year: number, month: number, day: number): SolarDate;
  };
}
