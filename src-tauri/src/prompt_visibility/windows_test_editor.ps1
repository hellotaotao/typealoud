$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.BackColor = [Drawing.Color]::Magenta
$form.WindowState = 'Maximized'
$form.Text = 'TypeAloud focus test'
$edit = New-Object System.Windows.Forms.TextBox
$form.Controls.Add($edit)
$edit.add_TextChanged({ [IO.File]::WriteAllText($env:TYPEALOUD_TEST_TEXT, $edit.Text) })
$form.add_Shown({
  $form.Activate()
  [void]$edit.Focus()
  [IO.File]::WriteAllText($env:TYPEALOUD_TEST_READY, $form.Handle.ToInt64().ToString())
})
[void]$form.ShowDialog()
