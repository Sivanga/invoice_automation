import os
import base64
import time
import re
import pandas as pd
from email.utils import parsedate_to_datetime
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from datetime import datetime
import logging
from google.auth.transport.requests import Request

SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/drive.file']
EXCLUDED_SENDERS = {
    'no_reply@email.apple.com',
    'no-reply@inform.bt.com',
    'rightmovenews@mail.rightmove.co.uk',
    'info@mountgrangeheritage.co.uk',
    'messages-noreply@linkedin.com',
    'no-reply@todoist.com'
}

logging.basicConfig(
    filename='/Users/sivangalamidi/Development/Gmail/gmail_invoices.log',
    level=logging.INFO,
    format='%(asctime)s %(message)s'
)

logging.info('Script started.')

def authenticate_services():
    creds = None
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
            creds = flow.run_local_server(port=8080, access_type='offline', prompt='consent')
        with open('token.json', 'w') as token:
            token.write(creds.to_json())
    gmail = build('gmail', 'v1', credentials=creds)
    drive = build('drive', 'v3', credentials=creds)
    return gmail, drive

def extract_amount(text):
    match = re.search(r'(\£|\$|€)?\s?(\d+[,.]?\d*)', text)
    return match.group(0) if match else ''

def get_messages(service):
    query = '-label:invoice (subject:(invoice OR bill OR inv) OR (overdue AND (payment OR fees)))'
    result = service.users().messages().list(userId='me', q=query).execute()
    return result.get('messages', [])

def get_or_create_folder(service, name, parent_id=None):
    query = f"name='{name}' and mimeType='application/vnd.google-apps.folder'"
    if parent_id:
        query += f" and '{parent_id}' in parents"
    response = service.files().list(q=query).execute()
    folders = response.get('files', [])
    if folders:
        return folders[0]['id']
    metadata = {'name': name, 'mimeType': 'application/vnd.google-apps.folder'}
    if parent_id:
        metadata['parents'] = [parent_id]
    folder = service.files().create(body=metadata, fields='id').execute()
    return folder['id']

def upload_to_drive(service, file_path):
    parent_folder = get_or_create_folder(service, 'Gmail Invoices')
    dated_folder = get_or_create_folder(service, datetime.now().strftime('%d%B%Y'), parent_folder)
    file_metadata = {'name': os.path.basename(file_path), 'parents': [dated_folder]}
    media = MediaFileUpload(file_path, resumable=True)
    service.files().create(body=file_metadata, media_body=media, fields='id').execute()

def create_invoice_label(service):
    labels = service.users().labels().list(userId='me').execute()
    existing_labels = [label['name'] for label in labels['labels']]

    if 'Invoice' not in existing_labels:
        label_metadata = {
            'name': 'Invoice',
            'labelListVisibility': 'labelShow',  # The label is visible in the label list
            'messageListVisibility': 'show'      # The label is visible in the message list
        }
        created_label = service.users().labels().create(userId='me', body=label_metadata).execute()
        print(f"Created new label: {created_label['name']}")
    else:
        print("The 'Invoice' label already exists.")

def get_label_id(service, label_name):
    labels = service.users().labels().list(userId='me').execute()
    for label in labels['labels']:
        if label['name'] == label_name:
            return label['id']
    return None  # Return None if label is not found        

def main():
    gmail, drive = authenticate_services()

    # Create the 'Invoice' label if it doesn't exist
    create_invoice_label(gmail)

    # Get the 'Invoice' label ID
    invoice_label_id = get_label_id(gmail, 'Invoice')
    
    if not invoice_label_id:
        print("❌ 'Invoice' label not found. Exiting script.")
        return  # Exit the script if the label is not found

    messages = get_messages(gmail)

    rows = []
    for msg in messages:
        msg_data = gmail.users().messages().get(userId='me', id=msg['id'], format='full').execute()
        headers = msg_data['payload']['headers']
        subject = next((h['value'] for h in headers if h['name'] == 'Subject'), '')
        date_str = next((h['value'] for h in headers if h['name'] == 'Date'), '')
        sender = next((h['value'] for h in headers if h['name'] == 'From'), '')
        snippet = msg_data.get('snippet', '')

        sender_email = re.findall(r'<(.*?)>', sender)
        email_address = sender_email[0] if sender_email else sender

        if email_address.lower() in EXCLUDED_SENDERS:
            continue

        parsed_date = parsedate_to_datetime(date_str) if date_str else None
        if parsed_date and parsed_date.tzinfo:
            parsed_date = parsed_date.replace(tzinfo=None)

        rows.append({
            'From': sender,
            'Subject': subject,
            'Date': parsed_date,
            'Snippet': snippet,
            'Amount': extract_amount(snippet),
            'Link': f"https://mail.google.com/mail/u/0/#inbox/{msg['id']}",
            'Paid By Me': ''
        })

        labels = {'addLabelIds': [invoice_label_id]}  # Use the label ID here

        # Mark as read
        gmail.users().messages().modify(userId='me', id=msg['id'], body=labels).execute()

    logging.info('Emails fetched and processed.')

    if rows:
        df = pd.DataFrame(rows)
        filename = 'invoices.xlsx'
        df.to_excel(filename, index=False)
        upload_to_drive(drive, filename)
        print(f"✅ {len(rows)} emails saved to {filename} and uploaded to Drive.")
    else:
        print("📭 No matching emails found.")

if __name__ == '__main__':
    main()
