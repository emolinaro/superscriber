import type { AdministrationPolicyViewModel } from "@/server/administration/service";

export function PolicySection({
  model,
}: {
  model: AdministrationPolicyViewModel;
  phoneSafetyMode: boolean;
}) {
  return (
    <section className="panel panel-strong administration-section stack" aria-labelledby="policy-heading">
      <div className="panel-inner stack administration-section__body">
        <div className="stack-tight">
          <p className="eyebrow">Policy</p>
          <h2 className="section-title" id="policy-heading" tabIndex={-1}>
            Policy
          </h2>
          <p className="body-copy">{model.profile.description}</p>
        </div>

        <div className="administration-policy-meta">
          <strong>{model.profile.label}</strong>
          <span>{model.profile.id}</span>
        </div>

        <div className="administration-table-wrap">
          <table className="administration-table administration-policy-table">
            <thead>
              <tr>
                <th scope="col">Capability</th>
                <th scope="col">Uploader</th>
                <th scope="col">Reviewer</th>
                <th scope="col">Approver</th>
                <th scope="col">Admin</th>
              </tr>
            </thead>
            <tbody>
              {model.rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.label}</th>
                  <td>{row.uploader}</td>
                  <td>{row.reviewer}</td>
                  <td>{row.approver}</td>
                  <td>{row.admin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="administration-card-list">
          {model.rows.map((row) => (
            <li className="administration-card-list__item" key={row.id}>
              <article className="administration-card stack-tight">
                <h3 className="card-title">{row.label}</h3>
                <dl className="administration-fact-list">
                  <div>
                    <dt>Uploader</dt>
                    <dd>{row.uploader}</dd>
                  </div>
                  <div>
                    <dt>Reviewer</dt>
                    <dd>{row.reviewer}</dd>
                  </div>
                  <div>
                    <dt>Approver</dt>
                    <dd>{row.approver}</dd>
                  </div>
                  <div>
                    <dt>Admin</dt>
                    <dd>{row.admin}</dd>
                  </div>
                </dl>
              </article>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
