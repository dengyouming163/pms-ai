# pms-ai-crew/src/crews/__init__.py
_crews = {}

def get_crew(name: str):
    if name not in _crews:
        if name == "daily_briefing":
            from src.crews.daily_briefing import create_daily_briefing_crew
            _crews[name] = create_daily_briefing_crew
        elif name == "pricing":
            from src.crews.pricing_crew import create_pricing_crew
            _crews[name] = create_pricing_crew
        elif name == "checkout_care":
            from src.crews.checkout_pipeline import create_checkout_care_crew
            _crews[name] = create_checkout_care_crew
        elif name == "housekeeping":
            from src.crews.housekeeping_crew import create_housekeeping_check_crew
            _crews[name] = create_housekeeping_check_crew
        elif name == "ota_check":
            from src.crews.ota_crew import create_ota_check_crew
            _crews[name] = create_ota_check_crew
        elif name == "ota_review":
            from src.crews.ota_crew import create_review_reply_crew
            _crews[name] = create_review_reply_crew
        elif name == "weekly_report":
            from src.crews.weekly_report_crew import create_weekly_report_crew
            _crews[name] = create_weekly_report_crew
        elif name == "monthly_report":
            from src.crews.weekly_report_crew import create_monthly_report_crew
            _crews[name] = create_monthly_report_crew
    return _crews[name]

__all__ = ["get_crew"]
