import React from 'react';
import { HiOutlineHeart } from 'react-icons/hi2';
import './SiteFooter.css';

export default function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__grid">
          <div className="site-footer__col">
            <h3 className="site-footer__heading">מטריה</h3>
            <p className="site-footer__text">
              מערכת לניתוח מסמכים, נתוני מעבדה מובנים והצגת החלטות בשקיפות — מותאמת לצוותי מחקר.
            </p>
          </div>
          <div className="site-footer__col">
            <h3 className="site-footer__heading">שימוש</h3>
            <ul className="site-footer__list">
              <li>העלאה ואינדקס של קבצים</li>
              <li>שאילתות מבוססות מסמכים</li>
              <li>מסלול מחקר והשוואות מעבדה</li>
            </ul>
          </div>
          <div className="site-footer__col">
            <h3 className="site-footer__heading">הערות</h3>
            <p className="site-footer__text">
              התצוגה מסכמת תוצאות שהוגדרו במערכת. לשאלות מתודולוגיות פנו למנהל הפרויקט.
            </p>
          </div>
        </div>
        <div className="site-footer__bottom">
          <span className="site-footer__copy">
            © {year} מטריה · כל הזכויות שמורות
          </span>
          <span className="site-footer__made">
            נבנה עם <HiOutlineHeart className="site-footer__heart" aria-hidden /> דיוק מחקרי
          </span>
        </div>
      </div>
    </footer>
  );
}
